const key = 'hookbrew.pending-launch.v1'
const hashPattern = /^0x[0-9a-fA-F]{64}$/

export function savePendingLaunch(record) {
  sessionStorage.setItem(
    key,
    JSON.stringify(record, (_, value) =>
      typeof value === 'bigint' ? { $bigint: value.toString() } : value,
    ),
  )
}

export function loadPendingLaunch(config) {
  if (!config) return null
  try {
    const record = JSON.parse(sessionStorage.getItem(key), (_, value) =>
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      /^\d{1,78}$/.test(value.$bigint || '')
        ? BigInt(value.$bigint)
        : value,
    )
    if (
      record?.chainId !== config.chainId ||
      record.factory?.toLowerCase() !== config.factory.toLowerCase() ||
      !hashPattern.test(record.hash) ||
      !record.prepared?.request ||
      !Array.isArray(record.prepared?.args)
    )
      return null
    return record
  } catch {
    return null
  }
}

export function clearPendingLaunch() {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* Storage can be disabled by the browser. */
  }
}
