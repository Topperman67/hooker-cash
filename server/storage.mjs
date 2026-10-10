// Persistent key/value storage. Redis (Upstash REST) for serverless, the filesystem for a single
// long-running server. Both expose the same interface so application code has one path.
import { readFile, writeFile, mkdir, link, unlink, rename, stat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { storageNamespace } from '../shared/network.mjs'

export function createRedisStore({ url, token, prefix = storageNamespace, request = fetch }) {
  if (!url?.startsWith('https://') || !token) throw Error('Configure both Redis REST credentials.')
  const key = (name) => `${prefix}:${name}`
  let syncToken
  async function command(...args) {
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
      const data = await response.json()
      if (!response.ok || !data || data.error || !Object.hasOwn(data, 'result')) throw Error()
      syncToken = response.headers.get('upstash-sync-token') || syncToken
      return data.result
    } catch {
      // Transport and JSON errors can contain upstream URLs or echoed credentials.
      throw Object.assign(Error('Persistent storage is unavailable. Try again shortly.'), {
        status: 503,
        code: 'STORAGE_UNAVAILABLE',
      })
    }
  }
  return {
    mode: 'redis',
    async incrementExpiring(name, ttl) {
      return Number(
        await command(
          'EVAL',
          "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return n",
          1,
          key(name),
          ttl,
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
    async putMedia(name, bytes, limit) {
      const result = await command(
        'EVAL',
        `
        if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
        local used = tonumber(redis.call('GET', KEYS[2]) or '0')
        if used + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return 0 end
        redis.call('SET', KEYS[1], ARGV[1])
        redis.call('INCRBY', KEYS[2], ARGV[2])
        return 1`,
        2,
        key(`media:${name}`),
        key('media:bytes'),
        JSON.stringify(bytes.toString('base64')),
        bytes.length,
        limit,
      )
      if (!result)
        throw Object.assign(Error('Media storage is full. Contact the operator.'), { status: 507 })
    },
    async getMedia(name) {
      const value = await command('GET', key(`media:${name}`))
      if (value === null) throw Object.assign(Error('Not found'), { code: 'ENOENT' })
      return Buffer.from(JSON.parse(value), 'base64')
    },
  }
}

export function createFileStore(dir) {
  const kv = resolve(dir, 'kv'),
    mediaDir = resolve(dir, 'media')
  const file = (name) => resolve(kv, createHash('sha256').update(name).digest('hex') + '.json')
  const counters = new Map()
  let mediaBytes = null
  async function read(name) {
    try {
      const entry = JSON.parse(await readFile(file(name), 'utf8'))
      if (entry.expires && entry.expires < Date.now()) return null
      return entry.value
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  async function write(name, value, ttl) {
    await mkdir(kv, { recursive: true })
    const temporary = `${file(name)}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify({ value, expires: ttl ? Date.now() + ttl : 0 }))
    return temporary
  }
  return {
    mode: 'filesystem',
    async incrementExpiring(name, ttl) {
      const now = Date.now()
      for (const [k, v] of counters) if (v.expires < now) counters.delete(k)
      const entry = counters.get(name) || { count: 0, expires: now + ttl }
      entry.count++
      counters.set(name, entry)
      return entry.count
    },
    async increment(name, amount = 1) {
      const next = Number((await read(name)) || 0) + amount
      await rename(await write(name, next), file(name))
      return next
    },
    get: read,
    async set(name, value, { nx = false, ttl = 0 } = {}) {
      const temporary = await write(name, value, ttl)
      if (!nx) {
        await rename(temporary, file(name))
        return true
      }
      try {
        if ((await read(name)) !== null) return false
        try {
          await unlink(file(name))
        } catch {}
        await link(temporary, file(name))
        return true
      } catch (e) {
        if (e.code === 'EEXIST') return false
        throw e
      } finally {
        try {
          await unlink(temporary)
        } catch {}
      }
    },
    async delete(name) {
      try {
        await unlink(file(name))
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    },
    async release(name, owner) {
      if (JSON.stringify(await read(name)) === JSON.stringify(owner)) await this.delete(name)
    },
    async putMedia(name, bytes, limit) {
      const target = resolve(mediaDir, name)
      try {
        await stat(target)
        return
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      if (mediaBytes === null) {
        mediaBytes = 0
        try {
          for (const n of await readdir(mediaDir))
            mediaBytes += (await stat(resolve(mediaDir, n))).size
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      }
      if (mediaBytes + bytes.length > limit)
        throw Object.assign(Error('Media storage is full. Contact the operator.'), { status: 507 })
      await mkdir(mediaDir, { recursive: true })
      try {
        await writeFile(target, bytes, { flag: 'wx' })
        mediaBytes += bytes.length
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    },
    getMedia: (name) => readFile(resolve(mediaDir, name)),
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
