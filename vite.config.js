import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createApplication } from './server/application.mjs'
import { applySecurityHeaders } from './server/start.mjs'

// The site's public origin, known at build time: VITE_PUBLIC_URL or QUANTPAD_PUBLIC_URL (from the
// environment or .env files), else Vercel's production domain. Null when none is set, when it is
// not an http(s) URL, or when it is still the .env.example placeholder (*.example).
export function publicOrigin(env) {
  const candidates = [
    env.VITE_PUBLIC_URL,
    env.QUANTPAD_PUBLIC_URL,
    env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ]
  for (const value of candidates) {
    let url
    try {
      url = new URL(String(value || '').trim())
    } catch {
      continue
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
    if (/(?:^|\.)example$/.test(url.hostname)) continue
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  }
  return null
}

const attribute = (value) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Link-preview scrapers (Open Graph, X) need absolute URLs: makes og:image, og:url and
// twitter:image absolute against `origin` and adds og:url (the home page) when it is missing.
export function absoluteOpenGraph(html, origin) {
  const absolute = (path) => attribute(`${origin}${path}`)
  let out = html.replace(
    /(<meta\s+(?:property|name)="(?:og:image|og:url|twitter:image)"\s+content=")(\/[^"]*)"/g,
    (_, head, path) => `${head}${absolute(path)}"`,
  )
  if (!/<meta\s+property="og:url"/.test(out))
    out = out.replace(
      /^([ \t]*)(<meta\s+property="og:image"[^>]*>)/m,
      (_, indent, tag) =>
        `${indent}${tag}\n${indent}<meta property="og:url" content="${absolute('/')}" />`,
    )
  return out
}

export function openGraphUrls(origin) {
  let logger
  return {
    name: 'quantpad-open-graph',
    apply: 'build',
    configResolved(config) {
      logger = config.logger
    },
    transformIndexHtml(html) {
      if (origin) return absoluteOpenGraph(html, origin)
      logger?.warn(
        'QUANTPAD_PUBLIC_URL (or VITE_PUBLIC_URL) is not set: og:image stays relative and link previews may show no image.',
      )
      return html
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    openGraphUrls(publicOrigin(loadEnv(mode, process.cwd(), ''))),
    {
      name: 'quantpad-api',
      async configureServer(server) {
        const app = await createApplication()
        server.middlewares.use(app.middleware)
        server.httpServer?.once('close', app.close)
      },
      // `npm run preview` serves the production build like `npm start`: the same API and the same
      // security headers (CSP and friends) on every response.
      async configurePreviewServer(server) {
        const app = await createApplication()
        server.middlewares.use((req, res, next) => {
          applySecurityHeaders(req, res)
          next()
        })
        server.middlewares.use(app.middleware)
        server.httpServer?.once('close', app.close)
      },
    },
  ],
  // Solana libraries expect Node's `global`; Buffer is installed in src/polyfills.js.
  define: { global: 'globalThis' },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js', '@solana/spl-token', 'bn.js', 'buffer'],
          meteora: [
            '@meteora-ag/dynamic-bonding-curve-sdk',
            '@meteora-ag/cp-amm-sdk',
            '@coral-xyz/anchor',
          ],
          charts: ['lightweight-charts'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // The dev server serves files from the repository root, which holds the program's deploy keypair
    // and local data: keep it on this machine. Use `--host` explicitly to test from a phone on the LAN.
    host: '127.0.0.1',
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key}',
        '**/.git/**',
        '**/target/**',
        '**/*keypair*.json',
        '**/.quantpad-data/**',
        '**/programs/**',
        '**/scripts/**',
      ],
    },
    // Windows can miss atomic file replacements and keep stale transformed components.
    watch: {
      usePolling: process.platform === 'win32',
      interval: 500,
      ignored: ['**/.quantpad-data/**', '**/artifacts/**', '**/programs/**'],
    },
  },
}))
