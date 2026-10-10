import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createApplication } from './server/application.mjs'
import securityHeaders from './server/security-headers.json' with { type: 'json' }

export default defineConfig({
  plugins: [
    react(),
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
          for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value)
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
          pump: ['@pump-fun/pump-sdk', '@pump-fun/pump-swap-sdk', '@coral-xyz/anchor'],
          charts: ['lightweight-charts'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    // Windows can miss atomic file replacements and keep stale transformed components.
    watch: {
      usePolling: process.platform === 'win32',
      interval: 500,
      ignored: ['**/.quantpad-data/**', '**/artifacts/**', '**/programs/**'],
    },
  },
})
