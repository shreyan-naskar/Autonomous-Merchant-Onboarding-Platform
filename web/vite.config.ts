import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiPort = process.env.API_PORT ?? process.env.PORT_API ?? '3000'
const mockPort = process.env.MOCK_PROVIDERS_PORT ?? '4000'

// The browser only talks to Vite (:5173). /api/* goes to the API and /mock/*
// to the mock providers, with the prefix stripped, so no CORS is needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, rewrite: (p) => p.replace(/^\/api/, '') },
      '/mock': { target: `http://localhost:${mockPort}`, rewrite: (p) => p.replace(/^\/mock/, '') },
    },
    // sample-data/*.json (repo root) is imported at build time by the submit page.
    fs: { allow: ['..'] },
  },
})
