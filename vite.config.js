import { defineConfig } from 'vite';

export default defineConfig({
  base: '/sdemux/',
  build: {
    outDir: 'dist',
    target: 'esnext'
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});