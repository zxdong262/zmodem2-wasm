import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/client-wasm',
  build: {
    outDir: '../../dist-wasm'
  },
  server: {
    port: 3002,
    strictPort: true
  }
})
