/**
 * sdemux — browser-based audio stem separation
 */

import { loadDemucsModel, separateStems, extractStems } from './demucs-loader.js';

// ── DOM refs ──
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const sourcePlayer = document.getElementById('source-player');
const sourceAudio = document.getElementById('source-audio');
const sourceInfo = document.getElementById('source-info');
const statusEl = document.getElementById('status');
const stemCards = document.getElementById('stem-cards');
const downloadAll = document.getElementById('download-all');
const waveCanvas = document.getElementById('wave-canvas');

// ── Audio context ──
let audioContext = null;
function getContext() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

// ── Model ──
let modelSession = null;

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

  const ctx = getContext();
  const arrayBuf = await file.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);

  // Show source player
  sourceAudio.src = URL.createObjectURL(file);
  sourcePlayer.style.display = 'block';
  sourceInfo.textContent = `${file.name} — ${audioBuf.numberOfChannels}ch / ${ctx.sampleRate}Hz / ${(audioBuf.duration).toFixed(1)}s`;

  // Start processing
  await processAudio(file, audioBuf);
}

// ── Processing ──
async function processAudio(file, audioBuf) {
  try {
    statusEl.textContent = 'Loading model...';

    // Load model (with progress)
    modelSession = await loadDemucsModel((p) => {
      if (p.stage === 'downloading') {
        const mb = ((p.received || 0) / 1024 / 1024).toFixed(1);
        const totalMb = ((p.total || 0) / 1024 / 1024).toFixed(1);
        statusEl.textContent = `Downloading model... ${mb} MB / ${totalMb} MB (${p.percent}%)`;
      } else if (p.stage === 'caching') {
        statusEl.textContent = 'Caching model...';
      } else if (p.stage === 'loading') {
        statusEl.textContent = 'Loading model...';
      } else if (p.stage === 'ready') {
        statusEl.textContent = 'Separating stems...';
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

  } catch (err) {
    statusEl.innerHTML = `<span style="color:#f87171">Error: ${err.message}</span>`;
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