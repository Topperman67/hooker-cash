import { createApplication } from '../server/application.mjs'
import { waitUntil } from '@vercel/functions'

let appPromise

async function getApp() {
  if (!appPromise) {
    appPromise = createApplication({
      dataDir: process.env.QUANTPAD_DATA_DIR || '/tmp/quantpad-data',
      serverless: true,
    }).catch((error) => {
      appPromise = null
      throw error
    })
  }
  return appPromise
}

function patchEnd(res) {
  return new Promise((resolve, reject) => {
    const originalEnd = res.end.bind(res)
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    res.end = (...args) => {
      try {
        originalEnd(...args)
        finish()
      } catch (e) {
        finish(e)
      }
    }
    res.on?.('error', finish)
  })
}

export default async function handler(req, res) {
  // The 60 s limit covers the request and the background pass together.
  const startedAt = Date.now()
  try {
    const app = await getApp()
    const done = patchEnd(res)
    await app.middleware(req, res, () => {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify({ error: 'Not found' }))
    })
    await done
    // Serverless instances can stop as soon as the response ends. Register the
    // bounded index pass with the platform instead of relying on setInterval.
    waitUntil(
      Promise.resolve(app.sync({ startedAt })).catch((error) =>
        console.error('Quant Pad background:', error.message),
      ),
    )
  } catch (e) {
    // Same rule as the application's own handler: only 4xx messages, and 5xx ones marked `expose`,
    // are meant for clients. Others (a failed start-up, a missing module) can name files or
    // configuration, so they are logged instead.
    const status = Number(e?.status)
    const client =
      Number.isInteger(status) &&
      status >= 400 &&
      (status < 500 || (e.expose === true && status < 600))
    if (!client) console.error('Quant Pad API:', e)
    if (!res.headersSent) {
      res.statusCode = client ? status : 500
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(
        JSON.stringify({
          error: client ? String(e.message) : 'Something went wrong. Try again.',
        }),
      )
    }
  }
}
