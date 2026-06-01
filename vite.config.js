import { defineConfig } from 'vite';

export default defineConfig({
  base: '/sdemux/',
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});