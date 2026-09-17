import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createApplication } from './application.mjs'
const app = await createApplication(),
  dist = resolve('dist')
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}
const server = createServer((req, res) =>
  app.middleware(req, res, async () => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://local').pathname),
        file = resolve(dist, '.' + p)
      if (!file.startsWith(dist + '/') && !file.startsWith(dist + '\\') && file !== dist) {
        res.writeHead(403)
        return res.end()
      }
      let data,
        ext = extname(file)
      try {
        data = await readFile(file)
      } catch {
        if (ext) {
          res.writeHead(404)
          return res.end()
        }
        data = await readFile(resolve(dist, 'index.html'))
        ext = '.html'
      }
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(data)
    } catch {
      res.writeHead(500)
      res.end('Could not serve page')
    }
  }),
)
server.listen(Number(process.env.PORT || 5173), process.env.HOST || '127.0.0.1', () =>
  console.log(`Hookbrew server listening on ${process.env.PORT || 5173}`),
)
process.on('SIGTERM', () => {
  app.close()
  server.close()
})
