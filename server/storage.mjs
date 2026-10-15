// Persistent key/value storage. Redis (Upstash REST) for serverless, the filesystem for a single
// long-running server. Both expose the same interface so application code has one path.
import {
  readFile,
  writeFile,
  mkdir,
  link,
  unlink,
  rename,
  stat,
  readdir,
  utimes,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { storageNamespace } from '../shared/network.mjs'

// Media (artwork and metadata blobs) share one byte quota, `limit` in putMedia.
//   putMedia(name, bytes, limit, { ttl }) resolves to true when it stored a new blob and false
//   when the blob already existed. With `ttl` (milliseconds) the upload is pending: it is served
//   like any other blob, but it expires and gives its bytes back to the quota unless
//   promoteMedia(name) makes it permanent first. Putting a blob that is already pending extends its
//   expiry (or, without `ttl`, makes it permanent).
//   promoteMedia(name) resolves to true when the blob now exists permanently, false when it is
//   missing or has expired.
const mediaTtl = (ttl) => Math.max(0, Math.floor(Number(ttl) || 0))
const mediaFull = () =>
  Object.assign(Error('Media storage is full. Contact the operator.'), {
    status: 507,
    expose: true,
  })

// Why a Redis command failed, as a short code that is safe to log and show: Upstash's own error
// text can echo request details, so only these codes leave this module. Upstash answers a used-up
// plan with "ERR max requests limit exceeded" (commands), "... bandwidth ..." or "... size ...".
export function failureReason({ status = 0, text = '', error = null } = {}) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout'
  const message = String(text)
  if (/bandwidth/i.test(message)) return 'quota-bandwidth'
  if (/(db|database|data) size|maxmemory|\bOOM\b/i.test(message)) return 'quota-size'
  if (/(request|command)s? limit/i.test(message)) return 'quota-requests'
  if (status === 401 || status === 403 || /WRONGPASS|NOAUTH|NOPERM|unauthori[sz]ed/i.test(message))
    return 'auth'
  if (status && (status < 200 || status >= 300)) return `http-${status}`
  if (status) return 'bad-response'
  return error ? 'unreachable' : 'error'
}

export function createRedisStore({
  url,
  token,
  prefix = storageNamespace,
  request = fetch,
  log = (message) => console.error(message),
  now = Date.now,
}) {
  if (!url?.startsWith('https://') || !token) throw Error('Configure both Redis REST credentials.')
  const key = (name) => `${prefix}:${name}`
  let syncToken
  // How the last command went, for /api/status: healthy is null until a command has run.
  const health = { healthy: null, reason: null, at: 0 }
  // After two failures in a row, commands fail at once for a while (1 s, doubling up to 30 s)
  // instead of each waiting on Upstash: a used-up plan is not asked again on every request, and
  // callers that can go on without storage (rate limits) do so without a 10 s timeout first.
  let failures = 0
  let retryAt = 0
  let loggedReason = null
  let loggedAt = 0
  function recordSuccess() {
    if (health.healthy === false) log('[storage] Redis is answering again.')
    failures = 0
    retryAt = 0
    Object.assign(health, { healthy: true, reason: null, at: now() })
  }
  function recordFailure(reason, status) {
    const at = now()
    failures++
    if (failures >= 2) retryAt = at + Math.min(30_000, 1000 * 2 ** (failures - 2))
    Object.assign(health, { healthy: false, reason, at })
    // Once per cause, then at most once a minute.
    if (reason !== loggedReason || at - loggedAt >= 60_000) {
      loggedReason = reason
      loggedAt = at
      log(`[storage] Redis command failed: ${reason}${status ? ` (HTTP ${status})` : ''}.`)
    }
  }
  // This message is written for users, so the API may show it (`expose`).
  const unavailable = () =>
    Object.assign(Error('Persistent storage is unavailable. Try again shortly.'), {
      status: 503,
      code: 'STORAGE_UNAVAILABLE',
      expose: true,
    })
  async function command(...args) {
    if (now() < retryAt) throw unavailable()
    let status = 0,
      text = ''
    try {
      const response = await request(url.replace(/\/$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(syncToken ? { 'upstash-sync-token': syncToken } : {}),
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000),
      })
      status = response.status
      text = await response.text()
      const data = JSON.parse(text)
      if (!response.ok || !data || data.error || !Object.hasOwn(data, 'result')) {
        if (data?.error) text = String(data.error)
        throw Error()
      }
      syncToken = response.headers.get('upstash-sync-token') || syncToken
      recordSuccess()
      return data.result
    } catch (error) {
      // Transport and JSON errors can contain upstream URLs or echoed credentials: only the
      // reason code is kept.
      recordFailure(failureReason({ status, text, error }), status)
      throw unavailable()
    }
  }
  return {
    mode: 'redis',
    health: () => ({ ...health }),
    // A health check that counts as a command: Upstash still answers PING (and ECHO) once a plan's
    // commands are used up, but refuses EXISTS like any data command.
    async check() {
      await command('EXISTS', key('health'))
    },
    // One command: INCRBY, and the expiry when the key is new.
    async incrementExpiring(name, ttl, amount = 1) {
      return Number(
        await command(
          'EVAL',
          "local n = redis.call('INCRBY', KEYS[1], ARGV[2]); if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return n",
          1,
          key(name),
          ttl,
          amount,
        ),
      )
    },
    async increment(name, amount = 1) {
      return Number(await command('INCRBY', key(name), amount))
    },
    async get(name) {
      const value = await command('GET', key(name))
      return value === null ? null : JSON.parse(value)
    },
    async set(name, value, { nx = false, ttl = 0 } = {}) {
      return (
        (await command(
          'SET',
          key(name),
          JSON.stringify(value),
          ...(nx ? ['NX'] : []),
          ...(ttl ? ['PX', ttl] : []),
        )) === 'OK'
      )
    },
    async delete(name) {
      await command('DEL', key(name))
    },
    async release(name, owner) {
      await command(
        'EVAL',
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        key(name),
        JSON.stringify(owner),
      )
    },
    // See the media notes above createFileStore. The quota counts what Redis stores: base64 inside
    // JSON, about 4/3 of the raw size. Pending blobs carry a PEXPIREAT and are listed in
    // media:pending (score = expiry) with their size in media:pending-size, so the bytes of an
    // expired upload are given back to the quota by the next put.
    async putMedia(name, bytes, limit, { ttl = 0 } = {}) {
      const encoded = JSON.stringify(bytes.toString('base64'))
      const result = Number(
        await command(
          'EVAL',
          `
          local ttl, now, name = tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6]
          local pending = redis.call('ZSCORE', KEYS[3], name)
          local exists = redis.call('EXISTS', KEYS[1]) == 1
          if pending and not exists then
            redis.call('DECRBY', KEYS[2], tonumber(redis.call('HGET', KEYS[4], name) or '0'))
            redis.call('ZREM', KEYS[3], name)
            redis.call('HDEL', KEYS[4], name)
          elseif pending and ttl > 0 then
            local expires = math.max(tonumber(pending), now + ttl)
            redis.call('ZADD', KEYS[3], expires, name)
            redis.call('PEXPIREAT', KEYS[1], expires)
            return 0
          elseif pending then
            redis.call('PERSIST', KEYS[1])
            redis.call('ZREM', KEYS[3], name)
            redis.call('HDEL', KEYS[4], name)
            return 0
          elseif exists and redis.call('PTTL', KEYS[1]) == -1 then
            return 0
          end
          local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 500)
          for _, member in ipairs(expired) do
            redis.call('DECRBY', KEYS[2], tonumber(redis.call('HGET', KEYS[4], member) or '0'))
            redis.call('ZREM', KEYS[3], member)
            redis.call('HDEL', KEYS[4], member)
          end
          local used = tonumber(redis.call('GET', KEYS[2]) or '0')
          if used + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return -1 end
          redis.call('SET', KEYS[1], ARGV[1])
          if ttl > 0 then
            redis.call('PEXPIREAT', KEYS[1], now + ttl)
            redis.call('ZADD', KEYS[3], now + ttl, name)
            redis.call('HSET', KEYS[4], name, ARGV[2])
          end
          redis.call('INCRBY', KEYS[2], ARGV[2])
          return 1`,
          4,
          key(`media:${name}`),
          key('media:bytes'),
          key('media:pending'),
          key('media:pending-size'),
          encoded,
          encoded.length,
          limit,
          mediaTtl(ttl),
          Date.now(),
          name,
        ),
      )
      if (result < 0) throw mediaFull()
      return result === 1
    },
    async promoteMedia(name) {
      const result = await command(
        'EVAL',
        `
        local pending = redis.call('ZSCORE', KEYS[3], ARGV[1])
        local exists = redis.call('EXISTS', KEYS[1]) == 1
        if pending then
          if exists then redis.call('PERSIST', KEYS[1]) else
            redis.call('DECRBY', KEYS[2], tonumber(redis.call('HGET', KEYS[4], ARGV[1]) or '0'))
          end
          redis.call('ZREM', KEYS[3], ARGV[1])
          redis.call('HDEL', KEYS[4], ARGV[1])
          return exists and 1 or 0
        end
        if exists and redis.call('PTTL', KEYS[1]) == -1 then return 1 end
        return 0`,
        4,
        key(`media:${name}`),
        key('media:bytes'),
        key('media:pending'),
        key('media:pending-size'),
        name,
      )
      return Number(result) === 1
    },
    async getMedia(name) {
      const value = await command('GET', key(`media:${name}`))
      if (value === null) throw Object.assign(Error('Not found'), { code: 'ENOENT' })
      return Buffer.from(JSON.parse(value), 'base64')
    },
  }
}

// Windows refuses to replace, rename or open a file while another handle is using it (EPERM,
// EACCES or EBUSY). Within one process the file store orders reads and writes per key so this does
// not happen; for other processes sharing the directory, retry briefly before giving up (~1.3 s).
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
export async function retryBusy(operation, { delays = [10, 20, 40, 80, 160, 320, 640] } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (e) {
      if (!BUSY.has(e?.code) || attempt >= delays.length) throw e
      await new Promise((done) => setTimeout(done, delays[attempt]))
    }
  }
}

export function createFileStore(dir) {
  const kv = resolve(dir, 'kv'),
    mediaDir = resolve(dir, 'media')
  const file = (name) => resolve(kv, createHash('sha256').update(name).digest('hex') + '.json')
  const counters = new Map()
  const pendingDir = resolve(mediaDir, 'pending')
  const MEDIA = Symbol('media') // queue for all media writes (quota bookkeeping is shared)
  const SWEEP_MS = 60_000
  let mediaBytes = null,
    lastSweep = 0
  // Operations on one key run one at a time in this process, so read-then-write sequences (NX sets,
  // increments, owner-checked releases) cannot interleave, and no read holds the file open while a
  // write replaces it (which fails on Windows).
  const queues = new Map()
  function serialized(name, task) {
    const run = (queues.get(name) || Promise.resolve()).then(task)
    const tail = run.catch(() => {})
    queues.set(name, tail)
    tail.then(() => queues.get(name) === tail && queues.delete(name))
    return run
  }
  const live = (entry) => !!entry && !(entry.expires && entry.expires < Date.now())
  async function readText(name) {
    try {
      return await retryBusy(() => readFile(file(name), 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  // The raw entry, expired or not. Only for use inside serialized tasks.
  async function readEntry(name) {
    const text = await readText(name)
    return text === null ? null : JSON.parse(text)
  }
  async function read(name) {
    const entry = await readEntry(name)
    return live(entry) ? entry.value : null
  }
  // Public reads queue behind writes to the same key. Concurrent reads of a key share one file
  // read; each caller parses its own copy, so callers can still modify what they get.
  const pendingReads = new Map()
  function get(name) {
    let text = pendingReads.get(name)
    if (!text) {
      text = serialized(name, () => readText(name))
      pendingReads.set(name, text)
      const clear = () => pendingReads.get(name) === text && pendingReads.delete(name)
      text.then(clear, clear)
    }
    return text.then((t) => {
      const entry = t === null ? null : JSON.parse(t)
      return live(entry) ? entry.value : null
    })
  }
  async function write(name, value, ttl) {
    await mkdir(kv, { recursive: true })
    const temporary = `${file(name)}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify({ value, expires: ttl ? Date.now() + ttl : 0 }))
    return temporary
  }
  const discard = (path) => retryBusy(() => unlink(path)).catch(() => {})
  async function replace(name, value, ttl) {
    const temporary = await write(name, value, ttl)
    try {
      await retryBusy(() => rename(temporary, file(name)))
    } catch (e) {
      await discard(temporary)
      throw e
    }
  }
  // Deletes the key only if the entry actually removed satisfies `matches`. The file is first moved
  // aside atomically; if another process replaced it meanwhile, that newer entry is put back.
  async function removeIf(name, matches) {
    const target = file(name),
      aside = `${target}.${randomBytes(8).toString('hex')}.old`
    try {
      await retryBusy(() => rename(target, aside))
    } catch (e) {
      if (e.code === 'ENOENT') return false
      throw e
    }
    let entry = null
    try {
      entry = JSON.parse(await readFile(aside, 'utf8'))
    } catch {}
    try {
      if (matches(entry)) return true
      await retryBusy(() => link(aside, target)).catch((e) => {
        if (e.code !== 'EEXIST') throw e
      })
      return false
    } finally {
      await discard(aside)
    }
  }
  // Exclusive create: link() fails with EEXIST instead of replacing. An expired entry is removed
  // only through removeIf, never by an unconditional unlink that could hit a fresh lease.
  async function setNx(name, value, ttl) {
    const temporary = await write(name, value, ttl)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await link(temporary, file(name))
          return true
        } catch (e) {
          if (e.code !== 'EEXIST') throw e
        }
        if (live(await readEntry(name))) return false
        await removeIf(name, (entry) => !live(entry))
      }
      return false
    } finally {
      await discard(temporary)
    }
  }
  // Media helpers; callers run them inside the MEDIA queue.
  async function statOrNull(path) {
    try {
      return await retryBusy(() => stat(path))
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  async function files(dir) {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile())
    } catch (e) {
      if (e.code === 'ENOENT') return []
      throw e
    }
  }
  // The stat of a live pending upload, or null. An expired one is deleted and its bytes are given
  // back to the quota.
  async function liveOrDrop(held) {
    const info = await statOrNull(held)
    if (!info || info.mtimeMs > Date.now()) return info
    try {
      await retryBusy(() => unlink(held))
      if (mediaBytes !== null) mediaBytes -= info.size
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    return null
  }
  // Deletes expired pending uploads and returns the bytes still pending.
  async function sweepPending() {
    let live = 0
    for (const entry of await files(pendingDir))
      live += (await liveOrDrop(resolve(pendingDir, entry.name)))?.size || 0
    lastSweep = Date.now()
    return live
  }
  async function mediaUsage() {
    if (mediaBytes === null) {
      let permanent = 0
      for (const entry of await files(mediaDir))
        permanent += (await stat(resolve(mediaDir, entry.name))).size
      mediaBytes = permanent + (await sweepPending())
    }
    return mediaBytes
  }
  async function promote(held, target) {
    await mkdir(mediaDir, { recursive: true })
    await retryBusy(() => rename(held, target))
  }
  return {
    mode: 'filesystem',
    async incrementExpiring(name, ttl, amount = 1) {
      const now = Date.now()
      for (const [k, v] of counters) if (v.expires < now) counters.delete(k)
      const entry = counters.get(name) || { count: 0, expires: now + ttl }
      entry.count += amount
      counters.set(name, entry)
      return entry.count
    },
    increment(name, amount = 1) {
      return serialized(name, async () => {
        const next = Number((await read(name)) || 0) + amount
        await replace(name, next)
        return next
      })
    },
    get,
    set(name, value, { nx = false, ttl = 0 } = {}) {
      return serialized(name, async () => {
        if (nx) return setNx(name, value, ttl)
        await replace(name, value, ttl)
        return true
      })
    },
    delete(name) {
      return serialized(name, async () => {
        try {
          await retryBusy(() => unlink(file(name)))
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      })
    },
    // Releases a lease held by `owner`, also after it has expired (expired lease files would
    // otherwise stay behind), but never a lease someone else has taken since.
    release(name, owner) {
      const owned = (entry) => !!entry && JSON.stringify(entry.value) === JSON.stringify(owner)
      return serialized(name, async () => {
        if (owned(await readEntry(name))) await removeIf(name, owned)
      })
    },
    // Pending uploads live in media/pending until promoted (renamed into media/). A pending
    // file's modification time is its expiry; expired ones are swept when the quota needs room,
    // and at most once a minute otherwise.
    putMedia(name, bytes, limit, { ttl = 0 } = {}) {
      const lifetime = mediaTtl(ttl)
      return serialized(MEDIA, async () => {
        const target = resolve(mediaDir, name),
          held = resolve(pendingDir, name)
        await mediaUsage()
        if (await statOrNull(target)) return false
        const pending = await liveOrDrop(held)
        if (pending) {
          if (lifetime) {
            const expires = Math.max(pending.mtimeMs, Date.now() + lifetime)
            await retryBusy(() => utimes(held, new Date(), new Date(expires)))
          } else await promote(held, target)
          return false
        }
        if (mediaBytes + bytes.length > limit || Date.now() - lastSweep > SWEEP_MS)
          await sweepPending()
        if (mediaBytes + bytes.length > limit) throw mediaFull()
        const path = lifetime ? held : target
        await mkdir(lifetime ? pendingDir : mediaDir, { recursive: true })
        try {
          await writeFile(path, bytes, { flag: 'wx' })
          if (lifetime) await utimes(path, new Date(), new Date(Date.now() + lifetime))
        } catch (e) {
          if (e.code === 'EEXIST') return false
          await discard(path)
          throw e
        }
        mediaBytes += bytes.length
        return true
      })
    },
    promoteMedia(name) {
      return serialized(MEDIA, async () => {
        const target = resolve(mediaDir, name)
        if (await liveOrDrop(resolve(pendingDir, name))) {
          await promote(resolve(pendingDir, name), target)
          return true
        }
        return !!(await statOrNull(target))
      })
    },
    async getMedia(name) {
      const target = resolve(mediaDir, name),
        held = resolve(pendingDir, name)
      try {
        return await retryBusy(() => readFile(target))
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      const pending = await statOrNull(held)
      if (pending && pending.mtimeMs > Date.now()) {
        try {
          return await retryBusy(() => readFile(held))
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      }
      // Promoted between the two reads, or missing (ENOENT).
      return retryBusy(() => readFile(target))
    },
  }
}

export function configuredStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN
  if (!url && !token) return null
  return createRedisStore({
    url,
    token,
    prefix:
      (env.QUANTPAD_STORAGE_PREFIX ? env.QUANTPAD_STORAGE_PREFIX + ':' : '') + storageNamespace,
  })
}
