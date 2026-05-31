/**
 * sdemux — browser-based audio stem separation
 */

import { loadDemucsModel, separateStems, extractStems } from './demucs-loader.js';
import JSZip from 'jszip';

// ── DOM refs ──
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const sourcePlayer = document.getElementById('source-player');
const sourceAudio = document.getElementById('source-audio');
const sourceInfo = document.getElementById('source-info');
const statusEl = document.getElementById('status');
const separateBtn = document.getElementById('separate-btn');
const stemCards = document.getElementById('stem-cards');
const downloadAll = document.getElementById('download-all');
const waveCanvas = document.getElementById('wave-canvas');

// ── Audio context ──
let audioContext = null;
function getContext() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

// ── State ──
let modelSession = null;
let currentFile = null;
let currentAudioBuf = null;
let isProcessing = false;

// ── Upload ──
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  if (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|m4a|ogg|flac)$/i)) {
    statusEl.textContent = 'Unsupported file type. Please use WAV or MP3.';
    return;
  }

  // Large file warning
  if (file.size > 50 * 1024 * 1024) {
    if (!confirm('Large files (>50 MB) may take several minutes and consume significant memory. Continue?')) {
      return;
    }
  }

  const ctx = getContext();
  const arrayBuf = await file.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);

  // Show source player — preview without triggering model loading
  sourceAudio.src = URL.createObjectURL(file);
  sourcePlayer.style.display = 'block';
  sourceInfo.textContent = `${file.name} — ${audioBuf.numberOfChannels}ch / ${ctx.sampleRate}Hz / ${(audioBuf.duration).toFixed(1)}s`;

  // Show Separator button — user manually starts the process
  separateBtn.style.display = 'block';
  statusEl.textContent = `Ready. Click "Separate Stems" to start.`;
  startWaveAnimation();

  // Store for later
  currentFile = file;
  currentAudioBuf = audioBuf;
}

// ── Separate button ──
separateBtn.addEventListener('click', async () => {
  if (isProcessing || !currentAudioBuf) return;
  isProcessing = true;
  separateBtn.disabled = true;
  separateBtn.textContent = 'Processing...';
  await processAudio(currentFile, currentAudioBuf);
  isProcessing = false;
  separateBtn.disabled = false;
  separateBtn.textContent = 'Separate Stems';
});

// ── Freeze overlay ──
function showFreezeOverlay(text) {
  // Create overlay if not exists
  let overlay = document.getElementById('freeze-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'freeze-overlay';
    overlay.innerHTML = `
      <div class="freeze-spinner"></div>
      <p id="freeze-text"></p>
    `;
    document.body.appendChild(overlay);
  }
  document.getElementById('freeze-text').textContent = text;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function hideFreezeOverlay() {
  const overlay = document.getElementById('freeze-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

// ── Processing ──
async function processAudio(file, audioBuf) {
  try {
    const loadStartTime = performance.now();
    statusEl.textContent = 'Loading model... (this may take 30-60 seconds)';

    startWaveAnimation();

    // Load model (with progress)
    modelSession = await loadDemucsModel((p) => {
      if (p.stage === 'downloading') {
        const mb = ((p.received || 0) / 1024 / 1024).toFixed(0);
        const totalMb = ((p.total || 0) / 1024 / 1024).toFixed(0);
        const speed = p.speedMBps || '?';
        const eta = p.eta || '?';
        statusEl.textContent = `Downloading model... ${mb}/${totalMb} MB (${p.percent}%) — ${speed} MB/s — ${eta} left`;
      } else if (p.stage === 'loading') {
        // Show full-screen overlay BEFORE the freeze hits
        showFreezeOverlay('Loading model into memory...\nBrowser will be unresponsive for 30-60s\nDo not close this tab.');
        // Force overlay to paint before blocking
        statusEl.textContent = 'Creating ONNX session... browser will freeze briefly.';
        stopWaveAnimation();
      } else if (p.stage === 'ready') {
        hideFreezeOverlay();
        startWaveAnimation();
        const elapsed = ((performance.now() - loadStartTime) / 1000).toFixed(0);
        statusEl.textContent = `Model ready (${elapsed}s). Separating stems...`;
      }
    });

    // Separate
    const result = await separateStems(modelSession, audioBuf, audioBuf.sampleRate, (p) => {
      statusEl.textContent = `Separating... chunk ${p.chunk}/${p.total}`;
    });

    // Extract to AudioBuffers
    const ctx = getContext();
    const stems = extractStems(result, audioBuf.sampleRate, ctx);

    // Display
    showStems(stems, ctx);
    window._stems = stems;
    statusEl.innerHTML = '<span style="color:#4ade80">Done!</span>';
    separateBtn.style.display = 'none';
    stopWaveAnimation();

  } catch (err) {
    hideFreezeOverlay();
    statusEl.innerHTML = `<span style="color:#f87171">Error: ${err.message}</span>`;
    stopWaveAnimation();
    console.error(err);
  }
}

// ── Display stems ──
const STEM_CONFIG = {
  drums:  { label: 'Drums',  emoji: '🥁', color: '#f97316' },
  bass:   { label: 'Bass',   emoji: '🎸', color: '#6366f1' },
  other:  { label: 'Other',  emoji: '🎹', color: '#ec4899' },
  vocals: { label: 'Vocals', emoji: '🎤', color: '#22c55e' },
};

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const headerSize = 44;
  const wav = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(wav);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const interleaved = new Float32Array(length * numChannels);
  for (let c = 0; c < numChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) interleaved[i * numChannels + c] = ch[i];
  }
  for (let i = 0; i < interleaved.length; i++) {
    const s = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([wav], { type: 'audio/wav' });
}

function showStems(stems, ctx) {
  const names = ['drums', 'bass', 'other', 'vocals'];
  stemCards.innerHTML = names.map(name => {
    const cfg = STEM_CONFIG[name];
    const url = URL.createObjectURL(audioBufferToWav(stems[name]));
    return `<div class="stem-card" style="border-left-color:${cfg.color}">
      <h3 style="color:${cfg.color}">${cfg.emoji} ${cfg.label}</h3>
      <audio controls src="${url}"></audio>
      <button onclick="downloadStem('${name}')">Download</button>
    </div>`;
  }).join('');
  downloadAll.style.display = 'block';
}

window.downloadStem = function(name) {
  const stems = window._stems;
  if (!stems || !stems[name]) return;
  const blob = audioBufferToWav(stems[name]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.wav`;
  a.click();
  URL.revokeObjectURL(url);
};

// ── ZIP download ──
downloadAll.addEventListener('click', async () => {
  const stems = window._stems;
  if (!stems) return;
  const zip = new JSZip();
  const names = ['drums', 'bass', 'other', 'vocals'];
  for (const name of names) {
    const blob = audioBufferToWav(stems[name]);
    zip.file(`${name}.wav`, blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stems.zip';
  a.click();
  URL.revokeObjectURL(url);
});

// ── Wave canvas animation ──
const waveCtx = waveCanvas.getContext('2d');
let waveAnimating = false;
let wavePhase = 0;
let waveFadeOut = false;
let waveFadeAlpha = 1.0;
let waveStartTime = 0;

function startWaveAnimation() {
  if (waveAnimating) return;
  waveAnimating = true;
  wavePhase = 0;
  waveFadeOut = false;
  waveFadeAlpha = 1.0;
  waveStartTime = performance.now();
  animateWaves();
}

function stopWaveAnimation() {
  waveFadeOut = true;
  waveStartTime = performance.now();
}

function animateWaves() {
  if (!waveAnimating) return;
  const w = waveCanvas.width = waveCanvas.clientWidth;
  const h = waveCanvas.height = waveCanvas.clientHeight;
  waveCtx.clearRect(0, 0, w, h);

  const stemNames = ['drums', 'bass', 'other', 'vocals'];

  if (waveFadeOut) {
    const elapsed = (performance.now() - waveStartTime) / 1000;
    waveFadeAlpha = Math.max(0, 1 - elapsed);
    if (waveFadeAlpha <= 0) {
      waveAnimating = false;
      waveCtx.clearRect(0, 0, w, h);
      return;
    }
  }

  for (let i = 0; i < 4; i++) {
    const cfg = STEM_CONFIG[stemNames[i]];
    const y = h * (0.15 + i * 0.22);
    const phase = wavePhase + i * Math.PI * 0.5;

    waveCtx.strokeStyle = cfg.color;
    waveCtx.globalAlpha = waveFadeAlpha * 0.7;
    waveCtx.lineWidth = 2;
    waveCtx.beginPath();
    waveCtx.moveTo(0, y);

    const cp1x = w * 0.2;
    const cp1y = y + Math.sin(phase) * 30;
    const cp2x = w * 0.7;
    const cp2y = y + Math.cos(phase * 1.3) * 25;
    const endX = w;
    const endY = y + Math.sin(phase * 0.7) * 15;

    waveCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endX, endY);
    waveCtx.stroke();

    waveCtx.fillStyle = cfg.color;
    waveCtx.globalAlpha = waveFadeAlpha;
    waveCtx.beginPath();
    waveCtx.arc(endX - 10, endY, 5, 0, Math.PI * 2);
    waveCtx.fill();
  }

  wavePhase += 0.03;
  requestAnimationFrame(animateWaves);
}

// ── Error checks ──
if (typeof WebAssembly !== 'object') {
  statusEl.innerHTML = '<span style="color:#f87171">This browser does not support WebAssembly. Please use Chrome, Firefox, or Edge.</span>';
}
