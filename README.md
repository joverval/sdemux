# sdemux

Browser-based audio stem separation using Demucs ONNX. Splits audio into vocals, drums, bass, and other — 100% client-side, no server needed.

**https://joverval.cl/sdemux/**

## How it works

- **Model**: `htdemucs_embedded.onnx` (172 MB) from [timcsy/demucs-web-onnx](https://huggingface.co/timcsy/demucs-web-onnx)
- **Inference**: [ONNX Runtime Web](https://onnxruntime.ai/) via WASM backend
- **STFT/FFT**: Custom JS implementation matching the C++ reference from [sevagh/demucs.onnx](https://github.com/sevagh/demucs.onnx)
- **Caching**: Model stored in IndexedDB after first download
- **Output**: 4 WAV stems + ZIP download

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Output goes to `dist/`. Copy into `joverval/joverval.github.io` repo as `sdemux/` for deployment.

## License

MIT