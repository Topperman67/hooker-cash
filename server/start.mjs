import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { brotliCompress, gzip, constants as zlib } from 'node:zlib'
import { createApplication } from './application.mjs'
import securityHeaders from './security-headers.json' with { type: 'json' }

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt'])
const compressors = {
  br: (data) =>
    promisify(brotliCompress)(data, {
      params: {
        [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
        [zlib.BROTLI_PARAM_QUALITY]: 10,
        [zlib.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
  gzip: (data) => promisify(gzip)(data, { level: 9 }),
}
// Vite content-hashes everything it emits under /assets/, so those files never change in place.
const IMMUTABLE = 'public, max-age=31536000, immutable'
const CACHE_LIMIT_BYTES = 64 * 1024 * 1024

// Preferred compression the client accepts (brotli, then gzip), honouring q=0; null for none.
export function pickEncoding(header) {
  const accepted = new Map()
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    accepted.set(name, q ? Number(q.slice(2)) : 1)
  }
  for (const encoding of ['br', 'gzip'])
    if ((accepted.get(encoding) ?? accepted.get('*')) > 0) return encoding
  return null
}

const notModified = (req, etag, mtime) => {
  const tags = req.headers['if-none-match']
  if (tags)
    return String(tags)
      .split(',')
      .some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
  const since = Date.parse(req.headers['if-modified-since'] || '')
  return Number.isFinite(since) && Math.floor(mtime / 1000) * 1000 <= since
}

// Serves the production build from `dist`: hashed /assets/* cache for a year, everything else
// revalidates (ETag / Last-Modified), text is brotli or gzip compressed, and unknown routes without
// a file extension get the SPA's index.html.
export function createStaticHandler({ dist = resolve('dist') } = {}) {
  const root = resolve(dist)
  const cache = new Map()
  let cachedBytes = 0
  function compressed(key, data, encoding) {
    let entry = cache.get(key)
    if (!entry) {
      if (cachedBytes > CACHE_LIMIT_BYTES) {
        cache.clear()
        cachedBytes = 0
      }
      entry = compressors[encoding](data).then(
        (body) => ((cachedBytes += body.length), body),
        (error) => (cache.delete(key), Promise.reject(error)),
      )
      cache.set(key, entry)
    }
    return entry
  }

  return async function serveStatic(req, res) {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      return res.end('Bad request')
    }
    try {
      let file = resolve(root, '.' + pathname)
      if (!file.startsWith(root + sep) && file !== root) {
        res.writeHead(403)
        return res.end()
      }
      let ext = extname(file),
        info = await stat(file).catch(() => null)
      if (!info?.isFile()) {
        if (ext) {
          res.writeHead(404)
          return res.end()
        }
        file = resolve(root, 'index.html')
        ext = '.html'
        info = await stat(file)
      }
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
      const headers = {
        'Content-Type': types[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': file.startsWith(resolve(root, 'assets') + sep) ? IMMUTABLE : 'no-cache',
        ETag: etag,
        'Last-Modified': info.mtime.toUTCString(),
      }
      if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding'
      if (notModified(req, etag, info.mtimeMs)) {
        res.writeHead(304, headers)
        return res.end()
      }
      let body = await readFile(file)
      const encoding =
        COMPRESSIBLE.has(ext) && body.length >= 1024 && pickEncoding(req.headers['accept-encoding'])
      if (encoding) {
        body = await compressed(`${encoding}:${etag}:${file}`, body, encoding)
        headers['Content-Encoding'] = encoding
      }
      headers['Content-Length'] = body.length
      res.writeHead(200, headers)
      res.end(body)
    } catch {
      if (res.headersSent) return res.destroy()
      res.writeHead(500)
      res.end('Could not serve page')
    }
  }
}

export async function startServer({
  port = Number(process.env.PORT || 5173),
  host = process.env.HOST || '127.0.0.1',
  dist = resolve('dist'),
} = {}) {
  const app = await createApplication()
  const serveStatic = createStaticHandler({ dist })
  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value)
    app.middleware(req, res, () => serveStatic(req, res))
  })
  server.listen(port, host, () => console.log(`Quant Pad server listening on ${port}`))
  process.on('SIGTERM', () => {
    app.close()
    server.close()
  })
  return server
}

// `npm start` (node server/start.mjs) runs the server; importing this module (tests) does not.
const main = (() => {
  try {
    return (
      !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    )
  } catch {
    return false
  }
})()
if (main) await startServer()
