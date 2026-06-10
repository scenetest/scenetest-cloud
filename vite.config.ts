import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/dashboard',
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
})
