import { defineConfig } from 'vite';
import { copyFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  base: '/sdemux/',
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) return 'assets/[name][extname]';
          if (assetInfo.name?.endsWith('.mjs')) return 'assets/[name][extname]';
          return 'assets/[name]-[hash][extname]';
        }
      }
    }
  },
  plugins: [{
    name: 'copy-ort-mjs',
    closeBundle() {
      // ONNX Runtime dynamically loads .mjs glue code — copy it to dist/assets/
      const src = resolve('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs');
      const dest = resolve('dist/assets/ort-wasm-simd-threaded.jsep.mjs');
      if (existsSync(src)) {
        copyFileSync(src, dest);
        console.log('  ✓ copied ort-wasm-simd-threaded.jsep.mjs');
      } else {
        console.warn('  ✗ ort-wasm-simd-threaded.jsep.mjs not found');
      }
    }
  }],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});