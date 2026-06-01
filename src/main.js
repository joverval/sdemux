/**
 * sdemux v2 — server-side stem separation via Demucs API
 * Boombox UI with cassette deck (input) and speaker (output)
 */

import JSZip from 'jszip';

const API_BASE = 'https://sdemux.joverval.cl/api';

// ── DOM refs ──
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const sourcePlayer = document.getElementById('source-player');
const sourceAudio = document.getElementById('source-audio');
const sourceInfo = document.getElementById('source-info');
const statusEl = document.getElementById('status');
const separateBtn = document.getElementById('separate-btn');
const stemGrid = document.getElementById('stem-cards');
const downloadAll = document.getElementById('download-all');
const playAllBtn = document.getElementById('play-all');
const spoolLeft = document.getElementById('spool-left');
const spoolRight = document.getElementById('spool-right');

// ── State ──
let currentFile = null;

// Web Audio playback
let audioCtx = null;
let activeSources = [];
let stemGains = {};
let stemBuffers = {};
let stemBlobs = {};
let isPlaying = false;

// ── Stem display config ──
const STEM_CONFIG = {
  vocals: { label: 'Vocals', emoji: '', color: '#c0392b' },
  drums:  { label: 'Drums',  emoji: '', color: '#c0392b' },
  bass:   { label: 'Bass',   emoji: '', color: '#c0392b' },
  other:  { label: 'Other',  emoji: '', color: '#c0392b' },
};

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

function handleFile(file) {
  if (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|m4a|ogg|flac)$/i)) {
    statusEl.textContent = 'Unsupported file type. Use MP3 or WAV.';
    return;
  }

  sourceAudio.src = URL.createObjectURL(file);
  sourcePlayer.style.display = 'block';
  sourceInfo.textContent = `${file.name}  \u2014  ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  separateBtn.style.display = 'block';
  statusEl.textContent = 'Ready. Press Separate to send to server.';
  stemGrid.innerHTML = '';
  downloadAll.style.display = 'none';
  playAllBtn.style.display = 'none';

  // Reset playback
  stopAll();
  stemBuffers = {};
  stemBlobs = {};

  currentFile = file;
}

// ── Separate button ──
separateBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  separateBtn.disabled = true;
  separateBtn.textContent = '▶ Uploading...';
  await processFile(currentFile);
  separateBtn.disabled = false;
  separateBtn.textContent = '▶ Separate';
});

// ── Play All button ──
playAllBtn.addEventListener('click', () => playAll());

// ── Spool animation ──
function startSpools() {
  spoolLeft.classList.add('spinning');
  spoolRight.classList.add('spinning');
}
function stopSpools() {
  spoolLeft.classList.remove('spinning');
  spoolRight.classList.remove('spinning');
}

// ── Speaker grille peel animation ──
let _peelStarted = false;
function updatePeel(progress) {
  if (!_peelStarted) {
    _peelStarted = true;
    document.querySelector('.speaker-grille').classList.add('peeling');
  }
  document.querySelector('.speaker-grille').style.setProperty('--peel-progress', progress);
}
function resetPeel() {
  _peelStarted = false;
  const grille = document.querySelector('.speaker-grille');
  if (grille) {
    grille.classList.remove('peeling');
    grille.style.removeProperty('--peel-progress');
  }
}

// ── Web Audio multi‑stem playback ──
async function setupStemBuffers() {
  if (!stemBlobs || Object.keys(stemBlobs).length === 0) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const names = ['vocals', 'drums', 'bass', 'other'];
  for (const name of names) {
    const blob = stemBlobs[name];
    if (!blob) continue;
    const buf = await blob.arrayBuffer();
    stemBuffers[name] = await audioCtx.decodeAudioData(buf);
  }
  playAllBtn.style.display = 'block';
  // Reveal mute buttons
  document.querySelectorAll('.btn-mute').forEach(b => b.style.display = '');
}

async function playAll() {
  if (isPlaying) {
    stopAll();
    return;
  }

  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Build source + gain for each loaded stem
  const names = ['vocals', 'drums', 'bass', 'other'];
  activeSources = [];
  stemGains = {};

  for (const name of names) {
    const buf = stemBuffers[name];
    if (!buf) continue;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.value = 1;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(0);
    activeSources.push(src);
    stemGains[name] = gain;

    // Update mute button to unmuted state
    const btn = document.querySelector(`.btn-mute[data-stem="${name}"]`);
    if (btn) {
      btn.textContent = '🔊';
      btn.classList.remove('muted');
    }
  }

  isPlaying = true;
  playAllBtn.textContent = '⏹ Stop';

  // Auto‑stop when all sources end (use the longest buffer)
  const maxDuration = Math.max(...activeSources.map(s => s.buffer ? s.buffer.duration : 0), 0);
  setTimeout(() => {
    if (isPlaying) stopAll();
  }, (maxDuration + 0.5) * 1000);

  // also stop when any source naturally ends
  activeSources.forEach(src => {
    src.onended = () => {
      if (isPlaying && activeSources.every(s => s.playbackState === 'finished' || s.playbackState === undefined)) {
        stopAll();
      }
    };
  });
}

function stopAll() {
  activeSources.forEach(src => {
    try { src.stop(); } catch (e) { /* already stopped */ }
  });
  activeSources = [];
  stemGains = {};
  isPlaying = false;
  playAllBtn.textContent = '▶ Play All';
}

function toggleStemMute(stemName) {
  const gain = stemGains[stemName];
  if (!gain) return;
  const muted = gain.gain.value === 0;
  gain.gain.value = muted ? 1 : 0;
  const btn = document.querySelector(`.btn-mute[data-stem="${stemName}"]`);
  if (btn) {
    btn.textContent = muted ? '🔊' : '🔇';
    btn.classList.toggle('muted', !muted);
  }
}

// ── API helpers ──
async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);

  const resp = await fetch(`${API_BASE}/separate`, {
    method: 'POST',
    body: form,
  });

  if (resp.status === 429) {
    const data = await resp.json();
    throw new Error(`Rate limited. Retry after ${data.retry_after_seconds || 30}s.`);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upload failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function pollStatus(jobId) {
  const resp = await fetch(`${API_BASE}/status/${jobId}`);
  if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);
  return resp.json();
}

async function downloadZip(jobId) {
  const resp = await fetch(`${API_BASE}/download/${jobId}`);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  return resp.blob();
}

// ── Processing ──
async function processFile(file) {
  startSpools();
  try {
    // 1. Upload
    statusEl.textContent = 'Uploading file...';
    let job = await uploadFile(file);
    const jobId = job.job_id;

    // 2. Poll until done
    const POLL_INTERVAL = 5000;
    const MAX_WAIT = 15 * 60 * 1000;
    const startTime = Date.now();

    while (true) {
      await sleep(POLL_INTERVAL);

      if (Date.now() - startTime > MAX_WAIT) {
        throw new Error('Timed out waiting for separation.');
      }

      job = await pollStatus(jobId);

      if (job.status === 'queued') {
        const mins = (job.estimated_wait_minutes || 0).toFixed(1);
        statusEl.textContent = `Queued #${job.position} \u2014 ~${mins} min wait`;
      } else if (job.status === 'processing') {
        const est = job.estimated_seconds || 150;
        const elapsed = job.elapsed_seconds || 0;
        const progress = Math.min(elapsed / est, 1);
        const pct = Math.round(progress * 100);
        updatePeel(progress);
        statusEl.textContent = `Processing... ${pct}%`;
      } else if (job.status === 'done') {
        break;
      } else {
        throw new Error(`Unexpected job status: ${job.status}`);
      }
    }

    statusEl.textContent = 'Downloading stems...';

    // 3. Download zip
    const zipBlob = await downloadZip(jobId);

    resetPeel();

    // 4. Unzip and display
    const zip = await JSZip.loadAsync(zipBlob);
    const stems = {};
    stemBlobs = {};
    const order = job.stem_names || ['vocals.mp3', 'drums.mp3', 'bass.mp3', 'other.mp3'];

    for (const name of order) {
      const file = zip.file(name);
      if (!file) continue;
      const blob = await file.async('blob');
      const stemName = name.replace(/\.mp3$/, '');
      stems[stemName] = URL.createObjectURL(blob);
      stemBlobs[stemName] = blob;
    }

    showStems(stems);
    setupStemBuffers();

    statusEl.textContent = `Done! ${job.stem_count} stems extracted.`;
    statusEl.style.color = '#27ae60';
    separateBtn.style.display = 'none';

  } catch (err) {
    resetPeel();
    statusEl.textContent = err.message;
    statusEl.style.color = 'var(--accent)';
    console.error(err);
  } finally {
    stopSpools();
  }
}

// ── Display stems in 2x2 grid ──
function showStems(stemUrls) {
  const displayOrder = ['vocals', 'drums', 'bass', 'other'];
  stemGrid.innerHTML = displayOrder
    .filter(name => stemUrls[name])
    .map(name => {
      const cfg = STEM_CONFIG[name];
      return `
        <div class="stem-card">
          <h3 style="color:var(--accent)">${cfg.label}</h3>
          <audio controls src="${stemUrls[name]}"></audio>
          <button class="btn-stem-dl" onclick="window._sdemux_downloadStem('${name}')">Download</button>
          <button class="btn-mute" data-stem="${name}" onclick="window._sdemux_toggleMute('${name}')" style="display:none">&#128264;</button>
        </div>`;
    })
    .join('');
  downloadAll.style.display = 'block';
}

// ── Per-stem download ──
window._stemUrls = {};
window._sdemux_downloadStem = function(name) {
  const url = window._stemUrls[name];
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.mp3`;
  a.click();
};

// ── Mute toggle (called from onclick in stem cards) ──
window._sdemux_toggleMute = function(name) {
  toggleStemMute(name);
};

// ── ZIP download (re-zip client-side) ──
downloadAll.addEventListener('click', async () => {
  const urls = window._stemUrls;
  if (!urls || Object.keys(urls).length === 0) return;
  const zip = new JSZip();
  const names = ['vocals', 'drums', 'bass', 'other'];
  for (const name of names) {
    const url = urls[name];
    if (!url) continue;
    const resp = await fetch(url);
    const blob = await resp.blob();
    zip.file(`${name}.mp3`, blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const zipUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = zipUrl;
  a.download = 'stems.zip';
  a.click();
  URL.revokeObjectURL(zipUrl);
});

// ── Stash stem URLs for per-stem & ZIP download ──
const _origShowStems = showStems;
showStems = function(stemUrls) {
  window._stemUrls = stemUrls;
  _origShowStems(stemUrls);
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}