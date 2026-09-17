// Shared state for serverless deployments. Never expose the REST token to the browser.
export function createRedisStore({ url, token, prefix = 'hookbrew:v1', request = fetch }) {
  if (!url?.startsWith('https://') || !token) throw Error('Configure both Redis REST credentials.')
  const key = (name) => `${prefix}:${name}`
  async function command(...args) {
    const response = await request(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    })
    const data = await response.json()
    if (!response.ok || data.error)
      throw Error('Persistent storage is unavailable. Try again shortly.')
    return data.result
  }
  return {
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
    async saveIndex(name, value, owner) {
      const saved = await command(
        'EVAL',
        "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[2], ARGV[2]) return 1",
        2,
        key(`${name}:lock`),
        key(name),
        JSON.stringify(owner),
        JSON.stringify(value),
      )
      if (!saved) throw Error('Index lease expired; the next request will resume indexing.')
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
        throw Object.assign(Error('Media storage is full. Contact the venue operator.'), {
          status: 507,
        })
    },
  }
}

export function configuredStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN
  if (!url && !token) return null
  return createRedisStore({ url, token, prefix: env.HOOKBREW_STORAGE_PREFIX || 'hookbrew:v1' })
}
