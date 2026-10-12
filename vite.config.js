import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { apiVerifyPlugin } from './vite.api-plugin.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiVerifyPlugin()],
})
