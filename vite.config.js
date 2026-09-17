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
  server: { port: 5173, host: true },
})
