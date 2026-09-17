import { createApplication } from '../server/application.mjs'
import { waitUntil } from '@vercel/functions'

let appPromise

async function getApp() {
  if (!appPromise) {
    appPromise = createApplication({
      dataDir: process.env.HOOKBREW_DATA_DIR || '/tmp/hookbrew-data',
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
      Promise.resolve(app.sync()).catch((error) => console.error('Hookbrew index:', error.message)),
    )
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = e.status || 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: e.message || 'Server error' }))
    }
  }
}
