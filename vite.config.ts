import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // the everyday dev server. The end-to-end tests start their own on other ports: see playwright.config.ts
  server: { port: 5183 },
})
