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

  if (file.size > 50 * 1024 * 1024) {
    if (!confirm('Large files (>50 MB) may take several minutes and consume significant memory. Continue?')) {
      return;
    }
  }

  const ctx = getContext();
  const arrayBuf = await file.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);

  sourceAudio.src = URL.createObjectURL(file);
  sourcePlayer.style.display = 'block';
  sourceInfo.textContent = `${file.name} — ${audioBuf.numberOfChannels}ch / ${ctx.sampleRate}Hz / ${(audioBuf.duration).toFixed(1)}s`;

  separateBtn.style.display = 'block';
  statusEl.textContent = 'Ready. Click "Separate Stems" to start.';

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

// ── Merge AudioBuffers (sum across channels) ──
function mergeAudioBuffers(buffers, ctx) {
  if (buffers.length === 0) return null;
  const first = buffers[0];
  const out = ctx.createBuffer(first.numberOfChannels, first.length, first.sampleRate);
  for (let c = 0; c < first.numberOfChannels; c++) {
    const outCh = out.getChannelData(c);
    for (const buf of buffers) {
      const src = buf.getChannelData(c);
      for (let i = 0; i < first.length; i++) outCh[i] += src[i];
    }
  }
  return out;
}

// ── Processing ──
async function processAudio(file, audioBuf) {
  try {
    const loadStartTime = performance.now();
    statusEl.textContent = 'Loading model... (this may take 30-60 seconds)';

    modelSession = await loadDemucsModel((p) => {
      if (p.stage === 'downloading') {
        const mb = ((p.received || 0) / 1024 / 1024).toFixed(0);
        const totalMb = ((p.total || 0) / 1024 / 1024).toFixed(0);
        const speed = p.speedMBps || '?';
        const eta = p.eta || '?';
        statusEl.textContent = `Downloading model... ${mb}/${totalMb} MB (${p.percent}%) — ${speed} MB/s — ${eta} left`;
      } else if (p.stage === 'loading') {
        showFreezeOverlay('Loading model into memory...\nBrowser will be unresponsive for 30-60s\nDo not close this tab.');
        statusEl.textContent = 'Creating ONNX session... browser will freeze briefly.';
      } else if (p.stage === 'ready') {
        hideFreezeOverlay();
        const elapsed = ((performance.now() - loadStartTime) / 1000).toFixed(0);
        statusEl.textContent = `Model ready (${elapsed}s). Separating stems...`;
      }
    });

    // Separate 4 stems
    const result = await separateStems(modelSession, audioBuf, audioBuf.sampleRate, (p) => {
      statusEl.textContent = `Separating... chunk ${p.chunk}/${p.total}`;
    });

    // Extract raw 4 stems
    const ctx = getContext();
    const rawStems = extractStems(result, audioBuf.sampleRate, ctx);

    // Merge drums+bass+other → instrumental, keep vocals
    const instrumental = mergeAudioBuffers([rawStems.drums, rawStems.bass, rawStems.other], ctx);
    const stems = {
      vocals: rawStems.vocals,
      instrumental: instrumental,
    };

    showStems(stems);
    window._stems = stems;
    statusEl.innerHTML = '<span style="color:#4ade80">Done!</span>';
    separateBtn.style.display = 'none';

  } catch (err) {
    hideFreezeOverlay();
    statusEl.innerHTML = `<span style="color:#f87171">Error: ${err.message}</span>`;
    console.error(err);
  }
}

// ── Display stems ──
const STEM_CONFIG = {
  vocals:       { label: 'Vocals',       emoji: '🎤', color: '#22c55e' },
  instrumental: { label: 'Instrumental',  emoji: '🎵', color: '#6366f1' },
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

function showStems(stems) {
  const names = ['vocals', 'instrumental'];
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
  const names = ['vocals', 'instrumental'];
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

// ── Error checks ──
if (typeof WebAssembly !== 'object') {
  statusEl.innerHTML = '<span style="color:#f87171">This browser does not support WebAssembly. Please use Chrome, Firefox, or Edge.</span>';
}