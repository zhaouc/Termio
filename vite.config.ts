import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src/tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    exclude: [...configDefaults.exclude, '**/._*'],
  },
  build: {
    target: ['es2021', 'safari13'],
    minify: 'esbuild',
    sourcemap: false,
  },
})
