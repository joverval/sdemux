/**
 * Spleeter 2-stem ONNX Model Loader
 *
 * Based on csukuangfj/sherpa-onnx-spleeter-2stems FP16 models (~19MB each)
 * Pipeline matches sherpa-onnx/scripts/spleeter/separate_onnx.py
 *
 * STFT: n_fft=4096, hop=1024, hann window, center=false
 * Input: magnitude STFT (first 1024 bins), chunked into 512-frame segments
 * Output: 2 stems (vocals, accompaniment) via Wiener soft masking
 *
 * Dual-model: vocals.onnx + accompaniment.onnx process stereo jointly.
 * Input shape [2, num_splits, 512, 1024] — channels × chunks × time × freq
 * Output shape [2, num_splits, 512, 1024] — magnitude estimates per channel
 */

import * as ort from 'onnxruntime-web';

const N_FFT = 4096;
const HOP = 1024;
const STFT_BINS = N_FFT / 2 + 1;    // 2049
const MODEL_BINS = 1024;             // keep only first 1024
const CLIP_FRAMES = 512;             // frames per model chunk
const EPS = 1e-10;

const MODELS = {
  vocals: '/sdemux/models/vocals.fp16.onnx',
  accompaniment: '/sdemux/models/accompaniment.fp16.onnx',
};

// GitHub Pages: no COOP/COEP → single-threaded WASM only
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = '/sdemux/assets/';
ort.env.logLevel = 'warning';

// ── Window ──
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}
const WINDOW = hannWindow(N_FFT);

// ── FFT (in-place, radix-2 Cooley-Tukey) ──
function fft(real, imag, n) {
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cR = 1, cI = 0;
      for (let k = 0; k < half; k++) {
        const e = i + k, o = e + half;
        const tR = cR * real[o] - cI * imag[o];
        const tI = cR * imag[o] + cI * real[o];
        real[o] = real[e] - tR; imag[o] = imag[e] - tI;
        real[e] += tR; imag[e] += tI;
        const nR = cR * wR - cI * wI;
        cI = cR * wI + cI * wR; cR = nR;
      }
    }
  }
}

/**
 * Compute stereo STFT (center=false, matching sherpa-onnx).
 * Returns { mag: Float32Array[2, frames, 1024], real: [2][frames][2049], imag: [2][frames][2049], nbFrames }
 */
function computeSTFT(channel0, channel1, nSamples) {
  const nbFrames = Math.floor(nSamples / HOP) + 1;
  
  const real0 = new Float32Array(nbFrames * STFT_BINS);
  const imag0 = new Float32Array(nbFrames * STFT_BINS);
  const real1 = new Float32Array(nbFrames * STFT_BINS);
  const imag1 = new Float32Array(nbFrames * STFT_BINS);
  const mag = new Float32Array(2 * nbFrames * MODEL_BINS);

  for (let ch = 0; ch < 2; ch++) {
    const src = ch === 0 ? channel0 : channel1;
    const reals = ch === 0 ? real0 : real1;
    const imags = ch === 0 ? imag0 : imag1;
    const magOff = ch * nbFrames * MODEL_BINS;

    for (let frame = 0; frame < nbFrames; frame++) {
      const start = frame * HOP;
      const r = new Float32Array(N_FFT);
      const im = new Float32Array(N_FFT);

      for (let i = 0; i < N_FFT; i++) {
        const idx = start + i;
        r[i] = (idx < nSamples ? src[idx] : 0) * WINDOW[i];
      }

      fft(r, im, N_FFT);

      // Store full bin complex data
      for (let f = 0; f < STFT_BINS; f++) {
        reals[frame * STFT_BINS + f] = r[f];
        imags[frame * STFT_BINS + f] = im[f];
        // Magnitude for first 1024 bins
        if (f < MODEL_BINS) {
          mag[magOff + frame * MODEL_BINS + f] = Math.sqrt(r[f] * r[f] + im[f] * im[f]);
        }
      }
    }
  }

  return { mag, real0, imag0, real1, imag1, nbFrames };
}

// ── ISTFT ──
function istft(maskedReal, maskedImag, nbFrames) {
  const outLen = (nbFrames - 1) * HOP + N_FFT;
  const out = new Float32Array(outLen);
  const wSum = new Float32Array(outLen);

  for (let frame = 0; frame < nbFrames; frame++) {
    const r = new Float32Array(N_FFT);
    const im = new Float32Array(N_FFT);

    // Copy masked complex, pad missing bins with 0
    for (let f = 0; f < STFT_BINS; f++) {
      r[f] = maskedReal[frame * STFT_BINS + f];
      im[f] = maskedImag[frame * STFT_BINS + f];
    }

    // Inverse FFT = forward FFT with conjugated input, then scale
    // IFFT(x) = conj(FFT(conj(x))) / N
    const rConj = new Float32Array(r);
    const imNeg = new Float32Array(im);
    for (let i = 0; i < N_FFT; i++) imNeg[i] = -imNeg[i];

    fft(rConj, imNeg, N_FFT);

    const start = frame * HOP;
    const scale = 1.0 / N_FFT;
    for (let i = 0; i < N_FFT; i++) {
      const idx = start + i;
      if (idx < outLen) {
        out[idx] += rConj[i] * scale * WINDOW[i];
        wSum[idx] += WINDOW[i] * WINDOW[i];
      }
    }
  }

  // Normalize by window overlap
  for (let i = 0; i < outLen; i++) {
    if (wSum[i] > EPS) out[i] /= wSum[i];
  }

  return out;
}

// ── IndexedDB cache ──
const DB_NAME = 'sdemux-spleeter-cache';
const DB_VERSION = 3;  // bumped to clear potentially corrupted cache from pre-.mjs deployment

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('models')) {
        db.createObjectStore('models');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('models', 'readonly');
      const req = tx.objectStore('models').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function cachePut(key, buffer) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put(buffer, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

// ── Download with progress ──
async function downloadModel(url, progressCallback) {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const total = parseInt(response.headers.get('content-length'), 10) || 0;
  const reader = response.body.getReader();
  const buffer = total > 0 ? new Uint8Array(total) : null;
  let offset = 0;
  let received = 0;
  const t0 = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (buffer && offset + value.length <= buffer.length) {
      buffer.set(value, offset);
    }
    offset += value.length;
    received += value.length;

    if (total && performance.now() - t0 > 200) {
      const pct = Math.round((received / total) * 100);
      const elapsed = (performance.now() - t0) / 1000;
      const speed = received / elapsed;
      const speedMBps = (speed / 1024 / 1024).toFixed(1);
      const eta = speed > 0 ? Math.round((total - received) / speed) : '?';
      progressCallback({ received, total, percent: pct, speedMBps, eta });
    }
  }
  return buffer || new Uint8Array(received);
}

// ── Load single model ──
async function loadModel(name, progressCallback) {
  const url = MODELS[name];

  // Check cache
  const cached = await cacheGet(name);
  if (cached) {
    progressCallback?.({ stage: 'loading', model: name });
    const session = await ort.InferenceSession.create(cached, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'basic',
    });
    progressCallback?.({ stage: 'ready', model: name });
    return session;
  }

  // Download
  progressCallback?.({ stage: 'downloading', model: name, percent: 0 });
  const buffer = await downloadModel(url, (p) => {
    p.model = name;
    p.stage = 'downloading';
    progressCallback?.(p);
  });

  // Cache (fire-and-forget)
  cachePut(name, buffer.buffer.slice(0)).catch(e =>
    console.warn(`Cache failed for ${name}:`, e)
  );

  // Create session
  progressCallback?.({ stage: 'loading', model: name });
  const session = await ort.InferenceSession.create(buffer.buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'basic',
  });
  progressCallback?.({ stage: 'ready', model: name });
  return session;
}

/**
 * Load both Spleeter models.
 * Returns { vocals: InferenceSession, accompaniment: InferenceSession }
 */
export async function loadSpleeterModels(progressCallback) {
  // Load both in parallel
  const [vocals, accompaniment] = await Promise.all([
    loadModel('vocals', progressCallback),
    loadModel('accompaniment', progressCallback),
  ]);
  return { vocals, accompaniment };
}

/**
 * Separate stems using Spleeter.
 * 
 * @param {{vocals: InferenceSession, accompaniment: InferenceSession}} sessions
 * @param {AudioBuffer} audioData
 * @param {number} sampleRate
 * @param {function} onProgress
 * @returns {Promise<{stemData: Float32Array[][][], channels: number, length: number}>}
 */
export async function separateStems(sessions, audioData, sampleRate, onProgress) {
  let channels = audioData.numberOfChannels;
  const nSamples = audioData.length;

  // Spleeter expects stereo — duplicate mono
  if (channels === 1) {
    const mono = audioData.getChannelData(0);
    const tmp = { getChannelData: (c) => c === 0 ? mono : mono, numberOfChannels: 2, length: nSamples };
    audioData = tmp;
    channels = 2;
  }

  const ch0 = audioData.getChannelData(0);
  const ch1 = audioData.getChannelData(1);

  // 1. Compute STFT (center=false)
  onProgress?.({ chunk: 0, total: 3, stage: 'stft' });
  const { mag, real0, imag0, real1, imag1, nbFrames } = computeSTFT(ch0, ch1, nSamples);

  // 2. Pad frames to multiple of CLIP_FRAMES (512)
  const padding = nbFrames % CLIP_FRAMES === 0 ? 0 : CLIP_FRAMES - (nbFrames % CLIP_FRAMES);
  const paddedFrames = nbFrames + padding;
  const numSplits = paddedFrames / CLIP_FRAMES;

  // Build padded magnitude tensor [2, numSplits, CLIP_FRAMES, MODEL_BINS]
  const inputTensor = new Float32Array(2 * numSplits * CLIP_FRAMES * MODEL_BINS);
  for (let ch = 0; ch < 2; ch++) {
    const chOff = ch * numSplits * CLIP_FRAMES * MODEL_BINS;
    for (let f = 0; f < paddedFrames; f++) {
      const split = Math.floor(f / CLIP_FRAMES);
      const pos = f % CLIP_FRAMES;
      const splitOff = split * CLIP_FRAMES * MODEL_BINS;
      for (let b = 0; b < MODEL_BINS; b++) {
        const srcIdx = f < nbFrames ? f * MODEL_BINS + b : 0; // pad with 0
        const val = f < nbFrames ? mag[ch * nbFrames * MODEL_BINS + srcIdx] : 0;
        inputTensor[chOff + splitOff + pos * MODEL_BINS + b] = val;
      }
    }
  }

  // 3. Run inference
  onProgress?.({ chunk: 1, total: 3, stage: 'inference' });
  const ortInput = new ort.Tensor('float32', inputTensor, [2, numSplits, CLIP_FRAMES, MODEL_BINS]);

  const [vocalsOut, accOut] = await Promise.all([
    sessions.vocals.run({ x: ortInput }),
    sessions.accompaniment.run({ x: ortInput }),
  ]);

  const vocalsEst = vocalsOut.y.data;    // [2, numSplits, CLIP_FRAMES, MODEL_BINS]
  const accEst = accOut.y.data;

  // 4. Compute Wiener soft masks
  onProgress?.({ chunk: 2, total: 3, stage: 'masking' });
  const maskVocals = new Float32Array(2 * paddedFrames * MODEL_BINS);
  const maskAcc = new Float32Array(2 * paddedFrames * MODEL_BINS);

  for (let ch = 0; ch < 2; ch++) {
    for (let f = 0; f < paddedFrames; f++) {
      const split = Math.floor(f / CLIP_FRAMES);
      const pos = f % CLIP_FRAMES;
      const splitOff = split * CLIP_FRAMES * MODEL_BINS;

      for (let b = 0; b < MODEL_BINS; b++) {
        const idx = ch * numSplits * CLIP_FRAMES * MODEL_BINS + splitOff + pos * MODEL_BINS + b;
        const v2 = vocalsEst[idx] * vocalsEst[idx];
        const a2 = accEst[idx] * accEst[idx];
        const sum = v2 + a2 + EPS;
        const globalOff = ch * paddedFrames * MODEL_BINS + f * MODEL_BINS + b;
        maskVocals[globalOff] = (v2 + EPS / 2) / sum;
        maskAcc[globalOff] = (a2 + EPS / 2) / sum;
      }
    }
  }

  // 5. Crop masks to original frame count
  const maskV_crop0 = new Float32Array(nbFrames * MODEL_BINS);
  const maskA_crop0 = new Float32Array(nbFrames * MODEL_BINS);
  const maskV_crop1 = new Float32Array(nbFrames * MODEL_BINS);
  const maskA_crop1 = new Float32Array(nbFrames * MODEL_BINS);

  for (let f = 0; f < nbFrames; f++) {
    for (let b = 0; b < MODEL_BINS; b++) {
      maskV_crop0[f * MODEL_BINS + b] = maskVocals[0 * paddedFrames * MODEL_BINS + f * MODEL_BINS + b];
      maskA_crop0[f * MODEL_BINS + b] = maskAcc[0 * paddedFrames * MODEL_BINS + f * MODEL_BINS + b];
      maskV_crop1[f * MODEL_BINS + b] = maskVocals[1 * paddedFrames * MODEL_BINS + f * MODEL_BINS + b];
      maskA_crop1[f * MODEL_BINS + b] = maskAcc[1 * paddedFrames * MODEL_BINS + f * MODEL_BINS + b];
    }
  }

  // 6. Apply masks to complex STFT + pad bins 1024->2049
  function applyMask(mask, realCh, imagCh) {
    const mReal = new Float32Array(nbFrames * STFT_BINS);
    const mImag = new Float32Array(nbFrames * STFT_BINS);
    for (let f = 0; f < nbFrames; f++) {
      for (let b = 0; b < STFT_BINS; b++) {
        const m = b < MODEL_BINS ? mask[f * MODEL_BINS + b] : 0;
        mReal[f * STFT_BINS + b] = realCh[f * STFT_BINS + b] * m;
        mImag[f * STFT_BINS + b] = imagCh[f * STFT_BINS + b] * m;
      }
    }
    return { real: mReal, imag: mImag };
  }

  const vocals0 = applyMask(maskV_crop0, real0, imag0);
  const vocals1 = applyMask(maskV_crop1, real1, imag1);
  const acc0 = applyMask(maskA_crop0, real0, imag0);
  const acc1 = applyMask(maskA_crop1, real1, imag1);

  // 7. ISTFT each
  onProgress?.({ chunk: 3, total: 3, stage: 'istft' });
  const wavV0 = istft(vocals0.real, vocals0.imag, nbFrames);
  const wavV1 = istft(vocals1.real, vocals1.imag, nbFrames);
  const wavA0 = istft(acc0.real, acc0.imag, nbFrames);
  const wavA1 = istft(acc1.real, acc1.imag, nbFrames);

  // 8. Pack into stemData format [stemIdx][channel][sample]
  const stemData = [
    [wavV0, wavV1],   // vocals
    [wavA0, wavA1],   // accompaniment
  ];

  return {
    stemData,
    channels: 2,
    length: nSamples,
    numStems: 2,
  };
}

/**
 * Extract stems to AudioBuffers.
 * Returns { vocals, accompaniment }
 */
export function extractStems(result, sampleRate, audioContext) {
  const { stemData, channels, length, numStems } = result;
  const names = ['vocals', 'accompaniment'];
  const buffers = {};

  for (let s = 0; s < numStems; s++) {
    const buf = audioContext.createBuffer(channels, length, sampleRate);
    for (let c = 0; c < channels; c++) {
      buf.getChannelData(c).set(stemData[s][c].subarray(0, length));
    }
    buffers[names[s]] = buf;
  }
  return buffers;
}
