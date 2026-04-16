// MSFG Scanner — main thread entry point.
// Responsibilities: intake validation, decode+downscale, worker dispatch,
// preview rendering, download.

const MAX_FILE_BYTES = 50 * 1024 * 1024;  // 50 MB hard cap
const MAX_MEGAPIXELS = 4_000_000;          // 4 MP processing budget

// DOM references
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const controls = document.getElementById('controls');
const preview = document.getElementById('preview');
const beforeImg = document.getElementById('before-img');
const afterImg = document.getElementById('after-img');
const presetSelect = document.getElementById('preset-select');
const downloadBtn = document.getElementById('download-btn');
const saveBtn = document.getElementById('save-btn');
const printBtn = document.getElementById('print-btn');
const statusEl = document.getElementById('status');

// State
let worker = null;
let workerReady = false;
let currentResultBlob = null;
let currentFileName = null;
let pendingJobId = 0;

// --- Status helpers --------------------------------------------------------

function setStatus(text, variant = '') {
  statusEl.textContent = text;
  statusEl.parentElement.classList.remove('is-working', 'is-error', 'is-success');
  if (variant) statusEl.parentElement.classList.add(variant);
}

// --- Worker setup ----------------------------------------------------------

function initWorker() {
  worker = new Worker('js/cv-worker.js');
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (e) => {
    console.error('Worker error:', e);
    setStatus(`Scanner worker crashed: ${e.message}`, 'is-error');
    dropzone.classList.add('is-disabled');
  });
  worker.postMessage({ type: 'init' });
}

function onWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      workerReady = true;
      setStatus('Ready. Drop an image to get started.');
      dropzone.classList.remove('is-disabled');
      break;

    case 'progress':
      setStatus(`Processing: ${msg.stage}…`, 'is-working');
      break;

    case 'result':
      if (msg.id !== pendingJobId) return;  // stale
      currentResultBlob = msg.blob;
      afterImg.src = URL.createObjectURL(msg.blob);
      setActionsEnabled(true);
      setStatus(`Done in ${msg.elapsedMs} ms (${msg.width}×${msg.height})`, 'is-success');
      break;

    case 'error':
      if (msg.id !== pendingJobId) return;
      console.error('Worker error:', msg);
      setStatus(`Error: ${msg.message}`, 'is-error');
      break;

    default:
      console.warn('Unknown worker message:', msg);
  }
}

// --- File intake -----------------------------------------------------------

const MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png:  [0x89, 0x50, 0x4E, 0x47],
};

async function detectFormat(file) {
  const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  for (const [name, magic] of Object.entries(MAGIC_BYTES)) {
    if (magic.every((b, i) => buf[i] === b)) return name;
  }
  return null;
}

async function handleFile(file) {
  if (!workerReady) {
    setStatus('Scanner still loading, please wait…', 'is-working');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setStatus(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 50 MB).`, 'is-error');
    return;
  }

  const format = await detectFormat(file);
  if (!format) {
    setStatus('Unsupported file type. Use JPG or PNG.', 'is-error');
    return;
  }

  currentFileName = file.name.replace(/\.[^.]+$/, '');
  setStatus('Decoding…', 'is-working');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    setStatus(`Couldn't decode image: ${err.message}`, 'is-error');
    return;
  }

  // Show source preview
  beforeImg.src = URL.createObjectURL(file);
  preview.hidden = false;
  controls.hidden = false;

  // Downscale if over megapixel budget
  const srcMP = bitmap.width * bitmap.height;
  let workBitmap = bitmap;
  if (srcMP > MAX_MEGAPIXELS) {
    const scale = Math.sqrt(MAX_MEGAPIXELS / srcMP);
    const tw = Math.round(bitmap.width * scale);
    const th = Math.round(bitmap.height * scale);
    workBitmap = await createImageBitmap(bitmap, {
      resizeWidth: tw,
      resizeHeight: th,
      resizeQuality: 'high',
    });
    bitmap.close();
  }

  // Dispatch to worker
  const jobId = ++pendingJobId;
  setActionsEnabled(false);
  currentResultBlob = null;
  afterImg.removeAttribute('src');

  const options = {
    preset: presetSelect.value,
  };

  setStatus('Enhancing…', 'is-working');
  worker.postMessage(
    { type: 'process', id: jobId, bitmap: workBitmap, options },
    [workBitmap],
  );
}

// --- Dropzone + file input wiring ------------------------------------------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
  fileInput.value = '';  // allow re-selecting same file
});

['dragenter', 'dragover'].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) handleFile(file);
});

// --- Output actions (Download / Save / Print) ------------------------------

function setActionsEnabled(enabled) {
  downloadBtn.disabled = !enabled;
  saveBtn.disabled = !enabled;
  printBtn.disabled = !enabled;
}

function defaultFilename() {
  return `${currentFileName || 'scan'}_cleaned.png`;
}

// Download: auto-save to Downloads folder with generated filename.
downloadBtn.addEventListener('click', () => {
  if (!currentResultBlob) return;
  const url = URL.createObjectURL(currentResultBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Save As: use File System Access API if available (Chrome/Edge), otherwise
// fall back to the same behavior as Download.
saveBtn.addEventListener('click', async () => {
  if (!currentResultBlob) return;

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultFilename(),
        types: [{
          description: 'PNG image',
          accept: { 'image/png': ['.png'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(currentResultBlob);
      await writable.close();
      setStatus(`Saved to ${handle.name}`, 'is-success');
    } catch (err) {
      if (err.name === 'AbortError') return;  // user cancelled
      console.error('Save failed:', err);
      setStatus(`Save failed: ${err.message}`, 'is-error');
    }
    return;
  }

  // Fallback for browsers without File System Access API
  downloadBtn.click();
});

// Print: open a minimal print window containing just the cleaned image,
// trigger the print dialog, then close on completion. Keeps the dashboard UI
// out of the print output.
printBtn.addEventListener('click', () => {
  if (!currentResultBlob) return;
  const url = URL.createObjectURL(currentResultBlob);
  const win = window.open('', '_blank', 'width=900,height=1100');
  if (!win) {
    setStatus('Popup blocked — allow popups to print.', 'is-error');
    URL.revokeObjectURL(url);
    return;
  }
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>Print — ${defaultFilename()}</title>
  <style>
    @page { margin: 0.5in; }
    html, body { margin: 0; padding: 0; background: white; }
    img {
      display: block;
      max-width: 100%;
      max-height: 100vh;
      margin: 0 auto;
    }
    @media print {
      img { max-height: none; }
    }
  </style>
</head>
<body>
  <img src="${url}" onload="window.focus(); window.print();" />
</body>
</html>`);
  win.document.close();
  win.addEventListener('afterprint', () => {
    URL.revokeObjectURL(url);
    win.close();
  });
});

// --- Init ------------------------------------------------------------------

dropzone.classList.add('is-disabled');
initWorker();
