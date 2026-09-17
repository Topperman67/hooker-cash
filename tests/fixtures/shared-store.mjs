// Models a durable store shared by otherwise isolated API instances.
export function sharedStore() {
  const values = new Map()
  const copy = (value) => JSON.parse(JSON.stringify(value))
  const get = async (key) => {
    const row = values.get(key)
    if (!row || (row.expires && row.expires <= Date.now())) return null
    return copy(row.value)
  }
  return {
    get,
    async set(key, value, { nx = false, ttl = 0 } = {}) {
      const row = values.get(key)
      if (nx && row && (!row.expires || row.expires > Date.now())) return false
      values.set(key, { value: copy(value), expires: ttl ? Date.now() + ttl : 0 })
      return true
    },
    async delete(key) {
      values.delete(key)
    },
    async release(key, owner) {
      if ((await get(key)) === owner) values.delete(key)
    },
    async saveIndex(key, value, owner) {
      if ((await get(`${key}:lock`)) !== owner) throw Error('Index lease expired')
      await this.set(key, value)
    },
    async putMedia(name, bytes, limit) {
      if (await get(`media:${name}`)) return
      const used = (await get('media:bytes')) || 0
      if (used + bytes.length > limit)
        throw Object.assign(Error('Media storage is full.'), { status: 507 })
      await this.set(`media:${name}`, bytes.toString('base64'))
      await this.set('media:bytes', used + bytes.length)
    },
  }
}
