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
const spoolLeft = document.getElementById('spool-left');
const spoolRight = document.getElementById('spool-right');

// ── State ──
let currentFile = null;

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

  currentFile = file;
}

// ── Separate button ──
separateBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  separateBtn.disabled = true;
  separateBtn.textContent = '\u25B6 Uploading...';
  await processFile(currentFile);
  separateBtn.disabled = false;
  separateBtn.textContent = '\u25B6 Separate';
});

// ── Spool animation ──
function startSpools() {
  spoolLeft.classList.add('spinning');
  spoolRight.classList.add('spinning');
}
function stopSpools() {
  spoolLeft.classList.remove('spinning');
  spoolRight.classList.remove('spinning');
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
        statusEl.textContent = 'Processing on server...';
      } else if (job.status === 'done') {
        break;
      } else {
        throw new Error(`Unexpected job status: ${job.status}`);
      }
    }

    statusEl.textContent = 'Downloading stems...';

    // 3. Download zip
    const zipBlob = await downloadZip(jobId);

    // 4. Unzip and display
    const zip = await JSZip.loadAsync(zipBlob);
    const stems = {};
    const order = job.stem_names || ['vocals.mp3', 'drums.mp3', 'bass.mp3', 'other.mp3'];

    for (const name of order) {
      const file = zip.file(name);
      if (!file) continue;
      const blob = await file.async('blob');
      const stemName = name.replace(/\.mp3$/, '');
      stems[stemName] = URL.createObjectURL(blob);
    }

    showStems(stems);

    statusEl.textContent = `Done! ${job.stem_count} stems extracted.`;
    statusEl.style.color = '#27ae60';
    separateBtn.style.display = 'none';

  } catch (err) {
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
          <button class="btn-stem-dl" onclick="downloadStem('${name}')">Download</button>
        </div>`;
    })
    .join('');
  downloadAll.style.display = 'block';
}

// ── Per-stem download ──
window._stemUrls = {};
window.downloadStem = function(name) {
  const url = window._stemUrls[name];
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.mp3`;
  a.click();
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