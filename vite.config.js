import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createApplication } from './server/application.mjs'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'hookbrew-api',
      async configureServer(server) {
        const app = await createApplication()
        server.middlewares.use(app.middleware)
        server.httpServer?.once('close', app.close)
      },
    },
  ],
  server: {
    port: 5173,
    host: true,
    // Windows can miss atomic file replacements and keep stale transformed components.
    watch: {
      usePolling: process.platform === 'win32',
      interval: 500,
      ignored: ['**/.hookbrew-data/**', '**/artifacts/**'],
    },
  },
})
