// MSFG Scanner — main thread entry point.
// Responsibilities: intake validation, worker dispatch, rotate/upscale/denoise
// /auto-levels ops, crop, and export (download/copy/print). Zoom/pan lives in
// viewport.js, slider adjustments in adjust.js, third-party decoders in
// decoders.js, pure helpers in util.js.

import {
  setImgSrc,
  clearImgSrc,
  escapeHtml,
  canvasToBlob,
  canvasesToPdfBlob,
  downscaleBitmapToBudget,
} from './util.js';
import {
  detectFormat,
  decodePdfPages,
  decodeHeic,
  decodeSvg,
} from './decoders.js';
import {
  cssFilterString,
  applySharpness,
  resetAdjustmentsState,
} from './adjust.js';
import {
  view,
  getVisibleSourceRect,
  setPanGuard,
} from './viewport.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;  // 50 MB hard cap
const MAX_MEGAPIXELS = 4_000_000;          // 4 MP processing budget

// DOM references
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const controls = document.getElementById('controls');
const documentTools = document.getElementById('document-tools');
const documentSummary = document.getElementById('document-summary');
const documentProfileStatus = document.getElementById('document-profile-status');
const pageStrip = document.getElementById('page-strip');
const pagePrevBtn = document.getElementById('page-prev-btn');
const pageNextBtn = document.getElementById('page-next-btn');
const applyAllBtn = document.getElementById('apply-all-btn');
const exportProfile = document.getElementById('export-profile');
const targetMb = document.getElementById('target-mb');
const filenameInput = document.getElementById('filename-input');
const searchText = document.getElementById('search-text');
const qualityPanel = document.getElementById('quality-panel');
const qualityList = document.getElementById('quality-list');
const preview = document.getElementById('preview');
const beforeImg = document.getElementById('before-img');
const afterImg = document.getElementById('after-img');
const afterViewport = document.getElementById('after-viewport');
const presetSelect = document.getElementById('preset-select');
const downloadBtn = document.getElementById('download-btn');
const pdfBtn = document.getElementById('pdf-btn');
const copyBtn = document.getElementById('copy-btn');
const printBtn = document.getElementById('print-btn');
const dashboardSaveBtn = document.getElementById('dashboard-save-btn');
const cropBtn = document.getElementById('crop-btn');
const cropApplyBtn = document.getElementById('crop-apply-btn');
const cropCancelBtn = document.getElementById('crop-cancel-btn');
const cropOverlay = document.getElementById('crop-overlay');
const cropRect = document.getElementById('crop-rect');
const statusEl = document.getElementById('status');
const rotateLeftBtn = document.getElementById('rotate-left-btn');
const rotateRightBtn = document.getElementById('rotate-right-btn');
const upscaleBtn = document.getElementById('upscale-btn');
const denoiseBtn = document.getElementById('denoise-btn');
const flattenLightBtn = document.getElementById('flatten-light-btn');
const autoLevelsBtn = document.getElementById('auto-levels-btn');
const cornersBtn = document.getElementById('corners-btn');
const cornersApplyBtn = document.getElementById('corners-apply-btn');
const cornersCancelBtn = document.getElementById('corners-cancel-btn');
const resetImgBtn = document.getElementById('reset-img-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const clearBtn = document.getElementById('clear-btn');
const actionsFooter = document.getElementById('actions-footer');
const reprocessBtn = document.getElementById('reprocess-btn');
const cornerOverlay = document.getElementById('corner-overlay');

// State
let worker = null;
let workerReady = false;
let currentResultBlob = null;     // what the After pane shows and exports use
let originalResultBlob = null;    // first worker output for this file (Reset Image restores this)
let originalSourceFile = null;    // decoded image File (post PDF/HEIC); used by Re-apply Preset
let currentFileName = null;
let pendingJobId = 0;
let documentPages = [];
let activePageIndex = -1;
let workerJobs = new Map();
let pageIdCounter = 0;

function makePage({ sourceFile, label, baseName, sourceText = '', pageNumber = 1, pageCount = 1 }) {
  return {
    id: ++pageIdCounter,
    sourceFile,
    label,
    baseName,
    pageNumber,
    pageCount,
    sourceText,
    resultBlob: null,
    originalResultBlob: null,
    processed: false,
    processing: false,
    history: [],
    future: [],
    warnings: [],
  };
}

function activePage() {
  return documentPages[activePageIndex] || null;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setPageResult(page, blob, options = {}) {
  if (!page) return;
  page.resultBlob = blob;
  page.processed = true;
  page.processing = false;
  if (options.setOriginal !== false) page.originalResultBlob = page.originalResultBlob || blob;
  page.warnings = [];
  if (page === activePage()) {
    currentResultBlob = blob;
    originalResultBlob = page.originalResultBlob;
    setImgSrc(afterImg, blob);
    setActionsEnabled(true);
    refreshQualityChecks();
  }
  renderPageStrip();
}

function pushHistory(label = 'Edit') {
  const page = activePage();
  if (!page || !currentResultBlob) return;
  page.history.push({ blob: currentResultBlob, label });
  if (page.history.length > 20) page.history.shift();
  page.future.length = 0;
  updateUndoRedoButtons();
}

function replaceActiveResult(blob, statusText, options = {}) {
  const page = activePage();
  if (!page) return replaceResult(blob, statusText);
  setPageResult(page, blob, { setOriginal: false });
  setStatus(statusText || 'Image updated.', options.variant || 'is-success');
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const page = activePage();
  undoBtn.disabled = !page || !page.history.length;
  redoBtn.disabled = !page || !page.future.length;
}

function renderPageStrip() {
  pageStrip.innerHTML = '';
  documentPages.forEach((page, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-chip';
    if (index === activePageIndex) btn.classList.add('is-active');
    if (page.processing) btn.classList.add('is-processing');
    if (page.warnings?.some((w) => w.level === 'warn')) btn.classList.add('is-warning');
    btn.textContent = page.label;
    btn.addEventListener('click', () => setActivePage(index));
    pageStrip.appendChild(btn);
  });
  const count = documentPages.length;
  documentSummary.textContent = count ? `${count} page${count === 1 ? '' : 's'} loaded` : 'No pages loaded';
  pagePrevBtn.disabled = activePageIndex <= 0;
  pageNextBtn.disabled = activePageIndex < 0 || activePageIndex >= count - 1;
  applyAllBtn.disabled = !count || !workerReady;
  documentTools.hidden = !count;
}

function setActivePage(index) {
  if (index < 0 || index >= documentPages.length) return;
  if (cropState.active) exitCropMode();
  if (cornerState.active) exitCornerMode();
  const oldPage = activePage();
  if (oldPage) oldPage.sourceText = searchText.value || oldPage.sourceText || '';
  activePageIndex = index;
  const page = activePage();
  originalSourceFile = page.sourceFile;
  currentFileName = page.baseName;
  originalResultBlob = page.originalResultBlob;
  currentResultBlob = page.resultBlob;
  setImgSrc(beforeImg, page.sourceFile);
  if (page.resultBlob) {
    setImgSrc(afterImg, page.resultBlob);
    setActionsEnabled(true);
  } else {
    clearImgSrc(afterImg);
    setActionsEnabled(false);
  }
  searchText.value = page.sourceText || '';
  documentProfileStatus.textContent = `Page ${index + 1} of ${documentPages.length}`;
  preview.hidden = false;
  controls.hidden = false;
  documentTools.hidden = false;
  actionsFooter.hidden = false;
  renderPageStrip();
  updateUndoRedoButtons();
  refreshQualityChecks();
}

function suggestedFilename(ext = 'pdf') {
  const raw = filenameInput.value.trim() || `${baseFilename()}_cleaned`;
  return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + `.${ext}`;
}

function statementTargetMb() {
  if (exportProfile.value !== 'compact' && exportProfile.value !== 'statement') return 0;
  const value = Number(targetMb.value);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

searchText.addEventListener('input', () => {
  const page = activePage();
  if (page) page.sourceText = searchText.value;
});

pagePrevBtn.addEventListener('click', () => setActivePage(activePageIndex - 1));
pageNextBtn.addEventListener('click', () => setActivePage(activePageIndex + 1));
applyAllBtn.addEventListener('click', async () => {
  if (!documentPages.length || !workerReady) return;
  applyAllBtn.disabled = true;
  for (let i = 0; i < documentPages.length; i++) {
    const page = documentPages[i];
    page.processing = true;
    renderPageStrip();
    setStatus(`Applying preset to page ${i + 1} of ${documentPages.length}…`, 'is-working');
    try {
      const result = await processImageFile(page.sourceFile, presetSelect.value);
      if (page.resultBlob) page.history.push({ blob: page.resultBlob, label: 'apply all' });
      page.future.length = 0;
      page.originalResultBlob = result.blob;
      setPageResult(page, result.blob);
    } catch (err) {
      page.processing = false;
      setStatus(`Apply All failed on page ${i + 1}: ${err.message}`, 'is-error');
      renderPageStrip();
      return;
    }
  }
  setActivePage(activePageIndex < 0 ? 0 : activePageIndex);
  setStatus('Applied preset to all pages.', 'is-success');
});

undoBtn.addEventListener('click', async () => {
  const page = activePage();
  if (!page || !page.history.length || !currentResultBlob) return;
  page.future.push({ blob: currentResultBlob, label: 'Redo' });
  const prior = page.history.pop();
  await replaceActiveResult(prior.blob, `Undid ${prior.label}.`);
});

redoBtn.addEventListener('click', async () => {
  const page = activePage();
  if (!page || !page.future.length || !currentResultBlob) return;
  page.history.push({ blob: currentResultBlob, label: 'Undo' });
  const next = page.future.pop();
  await replaceActiveResult(next.blob, 'Redid change.');
});

// --- Image-op helpers (Rotate, Upscale, Denoise, Auto Levels) -------------

// Decode currentResultBlob → canvas. Helper for the ops below.
async function decodeCurrentToCanvas() {
  if (!currentResultBlob) return null;
  const bmp = await createImageBitmap(currentResultBlob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

// Replace the current After image with a new blob. Before stays as the
// original source. natW/natH update via the afterImg load handler.
async function replaceResult(blob, statusText) {
  if (activePage()) {
    replaceActiveResult(blob, statusText);
    return;
  }
  currentResultBlob = blob;
  setImgSrc(afterImg, blob);
  setActionsEnabled(true);
  setStatus(statusText || 'Image updated.', 'is-success');
}

// Rotate 90° in the given direction (+1 = CW, -1 = CCW).
async function rotate(dir) {
  pushHistory('rotate');
  const src = await decodeCurrentToCanvas();
  if (!src) return;
  const out = document.createElement('canvas');
  out.width = src.height;
  out.height = src.width;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(dir * Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  const blob = await canvasToBlob(out);
  await replaceResult(blob, `Rotated to ${out.width}×${out.height}`);
}
rotateLeftBtn.addEventListener('click', () => rotate(-1));
rotateRightBtn.addEventListener('click', () => rotate(1));

// 2× upscale using two-pass bilinear (good enough for document photos;
// browser's built-in resampling handles quality well).
async function upscale() {
  pushHistory('upscale');
  const src = await decodeCurrentToCanvas();
  if (!src) return;
  if (src.width * src.height * 4 > 64_000_000) {  // would produce > 64 MP
    setStatus('Image already too large to upscale safely.', 'is-error');
    return;
  }
  const out = document.createElement('canvas');
  out.width = src.width * 2;
  out.height = src.height * 2;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  const blob = await canvasToBlob(out);
  await replaceResult(blob, `Upscaled to ${out.width}×${out.height}`);
}
upscaleBtn.addEventListener('click', upscale);

// Denoise: light 3x3 box blur averaged with the original (preserves edges
// better than a straight blur).
async function denoise() {
  pushHistory('denoise');
  const src = await decodeCurrentToCanvas();
  if (!src) return;
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const s = img.data;
  const out = new Uint8ClampedArray(s.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        out[i] = s[i]; out[i+1] = s[i+1]; out[i+2] = s[i+2]; out[i+3] = s[i+3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += s[i + c + dx * 4 + dy * w * 4];
          }
        }
        const avg = sum / 9;
        // 50/50 blend of original and blur — keeps edges while killing noise.
        out[i + c] = (s[i + c] + avg) * 0.5;
      }
      out[i + 3] = s[i + 3];
    }
  }
  const result = new ImageData(out, w, h);
  const c2 = document.createElement('canvas');
  c2.width = w; c2.height = h;
  c2.getContext('2d').putImageData(result, 0, 0);
  const blob = await canvasToBlob(c2);
  await replaceResult(blob, 'Denoised.');
}
denoiseBtn.addEventListener('click', denoise);

async function flattenLighting() {
  pushHistory('flatten lighting');
  const src = await decodeCurrentToCanvas();
  if (!src) return;
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d');
  const original = ctx.getImageData(0, 0, w, h);

  const blurCanvas = document.createElement('canvas');
  const scale = Math.max(8, Math.round(Math.max(w, h) / 140));
  blurCanvas.width = Math.max(1, Math.round(w / scale));
  blurCanvas.height = Math.max(1, Math.round(h / scale));
  const bctx = blurCanvas.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(src, 0, 0, blurCanvas.width, blurCanvas.height);
  bctx.filter = 'blur(18px)';
  bctx.drawImage(blurCanvas, 0, 0);

  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = w;
  bgCanvas.height = h;
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.imageSmoothingEnabled = true;
  bgCtx.imageSmoothingQuality = 'high';
  bgCtx.drawImage(blurCanvas, 0, 0, w, h);
  const bg = bgCtx.getImageData(0, 0, w, h);

  const o = original.data;
  const b = bg.data;
  for (let i = 0; i < o.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const background = Math.max(80, b[i + c]);
      const corrected = (o[i + c] / background) * 232;
      o[i + c] = Math.max(0, Math.min(255, corrected));
    }
  }
  ctx.putImageData(original, 0, 0);
  const blob = await canvasToBlob(src);
  await replaceResult(blob, 'Flattened shadows and folds.');
}
flattenLightBtn.addEventListener('click', flattenLighting);

// Auto Levels: stretch each RGB channel so its min→0 and max→255. Great for
// washed-out or low-contrast scans.
async function autoLevels() {
  pushHistory('auto levels');
  const src = await decodeCurrentToCanvas();
  if (!src) return;
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < rMin) rMin = d[i]; if (d[i] > rMax) rMax = d[i];
    if (d[i+1] < gMin) gMin = d[i+1]; if (d[i+1] > gMax) gMax = d[i+1];
    if (d[i+2] < bMin) bMin = d[i+2]; if (d[i+2] > bMax) bMax = d[i+2];
  }
  const rRange = Math.max(1, rMax - rMin);
  const gRange = Math.max(1, gMax - gMin);
  const bRange = Math.max(1, bMax - bMin);
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = ((d[i]   - rMin) / rRange) * 255;
    d[i+1] = ((d[i+1] - gMin) / gRange) * 255;
    d[i+2] = ((d[i+2] - bMin) / bRange) * 255;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await canvasToBlob(src);
  await replaceResult(blob, 'Auto levels applied.');
}
autoLevelsBtn.addEventListener('click', autoLevels);

// Reset Image: restore currentResultBlob from originalResultBlob (pre-crop,
// pre-rotate, pre-upscale, etc.). Doesn't touch slider adjustments.
resetImgBtn.addEventListener('click', async () => {
  if (!originalResultBlob) return;
  pushHistory('reset image');
  await replaceResult(originalResultBlob, 'Reverted to original result.');
});

// Clear: fully unload the current image and return to the dropzone state.
function clearAll() {
  if (cropState.active) exitCropMode();
  currentResultBlob = null;
  originalResultBlob = null;
  originalSourceFile = null;
  currentFileName = null;
  documentPages = [];
  activePageIndex = -1;
  workerJobs.clear();
  pendingJobId++;  // invalidate any in-flight worker job
  clearImgSrc(beforeImg);
  clearImgSrc(afterImg);
  view.ready = false;
  view.scale = 1; view.tx = 0; view.ty = 0;
  preview.hidden = true;
  controls.hidden = true;
  documentTools.hidden = true;
  actionsFooter.hidden = true;
  setActionsEnabled(false);
  renderPageStrip();
  resetAdjustmentsState();
  setStatus('Ready. Drop a file to get started.');
}
clearBtn.addEventListener('click', clearAll);

// Re-apply the currently selected preset to the original decoded source.
reprocessBtn.addEventListener('click', async () => {
  if (!originalSourceFile) return;
  await reprocessWithPreset(presetSelect.value);
});

// Auto-reprocess when the preset dropdown changes, so users don't need to
// click Apply. No-op until a file is loaded.
presetSelect.addEventListener('change', async () => {
  if (!originalSourceFile) return;
  await reprocessWithPreset(presetSelect.value);
});

async function reprocessWithPreset(presetName) {
  if (!originalSourceFile || !workerReady) return;
  const page = activePage();
  pushHistory('re-enhance');
  setStatus('Re-enhancing…', 'is-working');
  setActionsEnabled(false);
  currentResultBlob = null;
  clearImgSrc(afterImg);
  try {
    const result = await processImageFile(originalSourceFile, presetName);
    if (page) {
      page.originalResultBlob = result.blob;
      setPageResult(page, result.blob);
    } else {
      currentResultBlob = result.blob;
      originalResultBlob = result.blob;
      setImgSrc(afterImg, result.blob);
      setActionsEnabled(true);
    }
    setStatus(`Done in ${result.elapsedMs} ms (${result.width}×${result.height})`, 'is-success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'is-error');
  }
}

async function processImageFile(imageFile, presetName) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(imageFile);
  } catch (err) {
    throw new Error(`Couldn't decode image: ${err.message}`);
  }
  const workBitmap = await downscaleBitmapToBudget(bitmap, MAX_MEGAPIXELS);
  const jobId = ++pendingJobId;
  return new Promise((resolve, reject) => {
    workerJobs.set(jobId, { resolve, reject });
    worker.postMessage(
      { type: 'process', id: jobId, bitmap: workBitmap, options: { preset: presetName } },
      [workBitmap],
    );
  });
}

// --- Status helpers --------------------------------------------------------

function setStatus(text, variant = '') {
  statusEl.textContent = text;
  statusEl.classList.remove('is-working', 'is-error', 'is-success');
  if (variant) statusEl.classList.add(variant);
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
      setStatus('Ready. Drop a file to get started.');
      dropzone.classList.remove('is-disabled');
      break;

    case 'progress':
      setStatus(`Processing: ${msg.stage}…`, 'is-working');
      break;

    case 'result':
      if (workerJobs.has(msg.id)) {
        const job = workerJobs.get(msg.id);
        workerJobs.delete(msg.id);
        job.resolve(msg);
        return;
      }
      if (msg.id !== pendingJobId) return;
      currentResultBlob = msg.blob;
      originalResultBlob = msg.blob;  // anchor for "Reset Image"
      setImgSrc(afterImg, msg.blob);
      setActionsEnabled(true);
      setStatus(`Done in ${msg.elapsedMs} ms (${msg.width}×${msg.height})`, 'is-success');
      break;

    case 'error':
      if (workerJobs.has(msg.id)) {
        const job = workerJobs.get(msg.id);
        workerJobs.delete(msg.id);
        job.reject(new Error(msg.message));
        return;
      }
      if (msg.id !== pendingJobId) return;
      console.error('Worker error:', msg);
      setStatus(`Error: ${msg.message}`, 'is-error');
      break;

    default:
      console.warn('Unknown worker message:', msg);
  }
}

// --- File intake -----------------------------------------------------------

async function handleFile(file) {
  return handleFiles([file]);
}

async function decodeFileToPages(file) {
  const format = await detectFormat(file);
  if (!format) throw new Error('Unsupported file type. Use JPG, PNG, PDF, HEIC, or SVG.');
  const baseName = file.name.replace(/\.[^.]+$/, '');
  if (format === 'pdf') {
    setStatus(`Rendering ${file.name}…`, 'is-working');
    const pages = await decodePdfPages(file);
    return pages.map((page) => makePage({
      sourceFile: page.imageFile,
      sourceText: page.text,
      baseName,
      pageNumber: page.pageNumber,
      pageCount: page.pageCount,
      label: page.pageCount > 1 ? `${baseName} p${page.pageNumber}` : baseName,
    }));
  }

  let imageFile = file;
  if (format === 'heic') {
    setStatus(`Converting ${file.name}…`, 'is-working');
    imageFile = await decodeHeic(file);
  } else if (format === 'svg') {
    setStatus(`Rasterizing ${file.name}…`, 'is-working');
    imageFile = await decodeSvg(file);
  }
  return [makePage({ sourceFile: imageFile, baseName, label: baseName })];
}

async function handleFiles(files) {
  if (!workerReady) {
    setStatus('Scanner still loading, please wait…', 'is-working');
    return;
  }
  const selectedFiles = Array.from(files || []);
  if (!selectedFiles.length) return;
  for (const file of selectedFiles) {
    if (file.size > MAX_FILE_BYTES) {
      setStatus(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 50 MB).`, 'is-error');
      return;
    }
  }

  // Cancel any in-progress crop from a prior file.
  if (cropState.active) exitCropMode();
  if (cornerState.active) exitCornerMode();

  pendingJobId++;
  documentPages = [];
  activePageIndex = -1;
  workerJobs.clear();
  setActionsEnabled(false);
  clearImgSrc(beforeImg);
  clearImgSrc(afterImg);
  renderPageStrip();

  let pages = [];
  try {
    for (const file of selectedFiles) {
      pages.push(...await decodeFileToPages(file));
    }
  } catch (err) {
    setStatus(`Couldn't decode file: ${err.message}`, 'is-error');
    return;
  }

  documentPages = pages;
  if (pages[0]) filenameInput.value = `${pages[0].baseName}_cleaned`;
  preview.hidden = false;
  controls.hidden = false;
  documentTools.hidden = false;
  actionsFooter.hidden = false;
  resetAdjustmentsState();
  setActivePage(0);

  for (let i = 0; i < documentPages.length; i++) {
    const page = documentPages[i];
    page.processing = true;
    renderPageStrip();
    setStatus(`Enhancing page ${i + 1} of ${documentPages.length}…`, 'is-working');
    try {
      const result = await processImageFile(page.sourceFile, presetSelect.value);
      page.originalResultBlob = result.blob;
      setPageResult(page, result.blob);
      if (i === activePageIndex) {
        setStatus(`Done in ${result.elapsedMs} ms (${result.width}×${result.height})`, 'is-success');
      }
    } catch (err) {
      page.processing = false;
      setStatus(`Error on page ${i + 1}: ${err.message}`, 'is-error');
      renderPageStrip();
      return;
    }
  }
  setActivePage(0);
  setStatus(`Processed ${documentPages.length} page${documentPages.length === 1 ? '' : 's'}.`, 'is-success');
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
  const files = e.target.files;
  if (files?.length) handleFiles(files);
  fileInput.value = '';
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
  const files = e.dataTransfer.files;
  if (files?.length) handleFiles(files);
});

// --- Crop mode ------------------------------------------------------------

const cropState = {
  active: false,
  dragging: false,
  pointerId: null,
  // Drag start + current, in After-viewport CSS pixels.
  startX: 0, startY: 0,
  curX: 0, curY: 0,
};

const cornerState = {
  active: false,
  dragging: false,
  pointerId: null,
  activeCorner: null,
  points: {
    tl: { x: 0, y: 0 },
    tr: { x: 0, y: 0 },
    br: { x: 0, y: 0 },
    bl: { x: 0, y: 0 },
  },
};

// Block viewport panning on the After viewport while crop/corner editing owns
// that viewport's pointer events.
setPanGuard((vp) => (cropState.active || cornerState.active) && vp === afterViewport);

function enterCropMode() {
  if (!currentResultBlob || cropState.active) return;
  cropState.active = true;
  cropOverlay.hidden = false;
  cropRect.classList.remove('is-active');
  afterViewport.classList.add('is-cropping');
  cropBtn.hidden = true;
  cropApplyBtn.hidden = false;
  cropCancelBtn.hidden = false;
  cropApplyBtn.disabled = true;
  setStatus('Drag on the After preview to select a crop region.', 'is-working');
}

function exitCropMode() {
  cropState.active = false;
  cropState.dragging = false;
  cropState.pointerId = null;
  cropOverlay.hidden = true;
  cropRect.classList.remove('is-active');
  afterViewport.classList.remove('is-cropping');
  cropBtn.hidden = false;
  cropApplyBtn.hidden = true;
  cropCancelBtn.hidden = true;
}

function updateCropRectDom() {
  const x = Math.min(cropState.startX, cropState.curX);
  const y = Math.min(cropState.startY, cropState.curY);
  const w = Math.abs(cropState.curX - cropState.startX);
  const h = Math.abs(cropState.curY - cropState.startY);
  cropRect.style.left = x + 'px';
  cropRect.style.top = y + 'px';
  cropRect.style.width = w + 'px';
  cropRect.style.height = h + 'px';
  cropApplyBtn.disabled = w < 5 || h < 5;
}

cropOverlay.addEventListener('pointerdown', (e) => {
  if (!cropState.active || e.button !== 0) return;
  const rect = afterViewport.getBoundingClientRect();
  cropState.startX = e.clientX - rect.left;
  cropState.startY = e.clientY - rect.top;
  cropState.curX = cropState.startX;
  cropState.curY = cropState.startY;
  cropState.dragging = true;
  cropState.pointerId = e.pointerId;
  cropOverlay.setPointerCapture(e.pointerId);
  cropRect.classList.add('is-active');
  updateCropRectDom();
});

cropOverlay.addEventListener('pointermove', (e) => {
  if (!cropState.dragging || e.pointerId !== cropState.pointerId) return;
  const rect = afterViewport.getBoundingClientRect();
  cropState.curX = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
  cropState.curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  updateCropRectDom();
});

const endCropDrag = (e) => {
  if (e.pointerId !== cropState.pointerId) return;
  try { cropOverlay.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  cropState.dragging = false;
  cropState.pointerId = null;
};
cropOverlay.addEventListener('pointerup', endCropDrag);
cropOverlay.addEventListener('pointercancel', endCropDrag);

cropBtn.addEventListener('click', enterCropMode);
cropCancelBtn.addEventListener('click', () => {
  exitCropMode();
  setStatus('Crop cancelled.');
});

// Apply: replace currentResultBlob with a new PNG blob containing only the
// selected region. The viewport is re-fit to the new image.
cropApplyBtn.addEventListener('click', async () => {
  if (!cropState.active) return;
  try {
    setStatus('Applying crop…', 'is-working');
    const croppedCanvas = await renderCropCanvas();
    if (!croppedCanvas) { setStatus('Crop region empty.', 'is-error'); return; }
    pushHistory('crop');
    const blob = await new Promise((resolve, reject) => {
      croppedCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
    });
    await replaceActiveResult(blob, `Cropped to ${croppedCanvas.width}×${croppedCanvas.height}`);
    exitCropMode();
  } catch (err) {
    console.error('Crop failed:', err);
    setStatus(`Crop failed: ${err.message}`, 'is-error');
  }
});

function initCornerPoints() {
  const rect = afterViewport.getBoundingClientRect();
  const x1 = Math.max(0, Math.min(rect.width, view.tx));
  const y1 = Math.max(0, Math.min(rect.height, view.ty));
  const x2 = Math.max(0, Math.min(rect.width, view.tx + view.natW * view.scale));
  const y2 = Math.max(0, Math.min(rect.height, view.ty + view.natH * view.scale));
  cornerState.points = {
    tl: { x: x1, y: y1 },
    tr: { x: x2, y: y1 },
    br: { x: x2, y: y2 },
    bl: { x: x1, y: y2 },
  };
}

function updateCornerHandles() {
  const rect = afterViewport.getBoundingClientRect();
  const points = Object.values(cornerState.points);
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  cornerOverlay.style.setProperty('--sc-corner-left', `${left}px`);
  cornerOverlay.style.setProperty('--sc-corner-right', `${Math.max(0, rect.width - right)}px`);
  cornerOverlay.style.setProperty('--sc-corner-top', `${top}px`);
  cornerOverlay.style.setProperty('--sc-corner-bottom', `${Math.max(0, rect.height - bottom)}px`);

  cornerOverlay.querySelectorAll('.corner-handle').forEach((handle) => {
    const point = cornerState.points[handle.dataset.corner];
    handle.style.left = `${point.x}px`;
    handle.style.top = `${point.y}px`;
  });
}

function enterCornerMode() {
  if (!currentResultBlob || cornerState.active) return;
  if (cropState.active) exitCropMode();
  cornerState.active = true;
  initCornerPoints();
  updateCornerHandles();
  cornerOverlay.hidden = false;
  cornersBtn.hidden = true;
  cornersApplyBtn.hidden = false;
  cornersCancelBtn.hidden = false;
  setStatus('Drag the four handles to the page corners, then apply.', 'is-working');
}

function exitCornerMode() {
  cornerState.active = false;
  cornerState.dragging = false;
  cornerState.pointerId = null;
  cornerState.activeCorner = null;
  cornerOverlay.hidden = true;
  cornersBtn.hidden = false;
  cornersApplyBtn.hidden = true;
  cornersCancelBtn.hidden = true;
}

function cornerCssToBlobPoint(point, bmp) {
  const sx = (point.x - view.tx) / view.scale;
  const sy = (point.y - view.ty) / view.scale;
  const kx = bmp.width / view.natW;
  const ky = bmp.height / view.natH;
  return {
    x: Math.max(0, Math.min(bmp.width - 1, sx * kx)),
    y: Math.max(0, Math.min(bmp.height - 1, sy * ky)),
  };
}

function sendWarpJob(bitmap, points) {
  const jobId = ++pendingJobId;
  return new Promise((resolve, reject) => {
    workerJobs.set(jobId, { resolve, reject });
    worker.postMessage({ type: 'warp', id: jobId, bitmap, points }, [bitmap]);
  });
}

cornerOverlay.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.corner-handle');
  if (!cornerState.active || !handle || e.button !== 0) return;
  cornerState.dragging = true;
  cornerState.pointerId = e.pointerId;
  cornerState.activeCorner = handle.dataset.corner;
  handle.classList.add('is-dragging');
  cornerOverlay.setPointerCapture(e.pointerId);
});

cornerOverlay.addEventListener('pointermove', (e) => {
  if (!cornerState.dragging || e.pointerId !== cornerState.pointerId) return;
  const rect = afterViewport.getBoundingClientRect();
  const point = cornerState.points[cornerState.activeCorner];
  point.x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  point.y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  updateCornerHandles();
});

const endCornerDrag = (e) => {
  if (e.pointerId !== cornerState.pointerId) return;
  cornerOverlay.querySelectorAll('.corner-handle').forEach((handle) => handle.classList.remove('is-dragging'));
  try { cornerOverlay.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  cornerState.dragging = false;
  cornerState.pointerId = null;
  cornerState.activeCorner = null;
};
cornerOverlay.addEventListener('pointerup', endCornerDrag);
cornerOverlay.addEventListener('pointercancel', endCornerDrag);

cornersBtn.addEventListener('click', enterCornerMode);
cornersCancelBtn.addEventListener('click', () => {
  exitCornerMode();
  setStatus('Corner correction cancelled.');
});

cornersApplyBtn.addEventListener('click', async () => {
  if (!cornerState.active || !currentResultBlob) return;
  try {
    setStatus('Applying corner correction…', 'is-working');
    pushHistory('corner correction');
    const bmp = await createImageBitmap(currentResultBlob);
    const points = ['tl', 'tr', 'br', 'bl'].map((key) => cornerCssToBlobPoint(cornerState.points[key], bmp));
    const result = await sendWarpJob(bmp, points);
    await replaceActiveResult(result.blob, `Corner corrected to ${result.width}×${result.height}.`);
    exitCornerMode();
  } catch (err) {
    setStatus(`Corner correction failed: ${err.message}`, 'is-error');
  }
});

// Map the selected viewport rectangle → source-image coords (UNCLAMPED, so
// whitespace around the image becomes white padding in the output). Then
// draw the intersected image region onto a white canvas at the correct
// offset. Adjustments are baked in.
async function renderCropCanvas() {
  if (!currentResultBlob) return null;
  const x1 = Math.min(cropState.startX, cropState.curX);
  const y1 = Math.min(cropState.startY, cropState.curY);
  const x2 = Math.max(cropState.startX, cropState.curX);
  const y2 = Math.max(cropState.startY, cropState.curY);
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;

  // Selected rectangle in source-image coordinate space (may extend outside 0..natW/H).
  const sx1 = (x1 - view.tx) / view.scale;
  const sy1 = (y1 - view.ty) / view.scale;
  const sx2 = (x2 - view.tx) / view.scale;
  const sy2 = (y2 - view.ty) / view.scale;
  const selW = sx2 - sx1;
  const selH = sy2 - sy1;
  if (selW < 1 || selH < 1) return null;

  const bmp = await createImageBitmap(currentResultBlob);
  const resW = bmp.width;
  const resH = bmp.height;
  const kx = resW / view.natW;
  const ky = resH / view.natH;

  // Output canvas size in result-blob pixels (selection at full fidelity).
  const outW = Math.max(1, Math.round(selW * kx));
  const outH = Math.max(1, Math.round(selH * ky));

  // Clamp to the valid portion of the source/result for actual drawing.
  const clampX1 = Math.max(0, sx1);
  const clampY1 = Math.max(0, sy1);
  const clampX2 = Math.min(view.natW, sx2);
  const clampY2 = Math.min(view.natH, sy2);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  // Fill whitespace (area outside the image) with white.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  if (clampX2 > clampX1 && clampY2 > clampY1) {
    // Source (in result pixels)
    const rx = Math.round(clampX1 * kx);
    const ry = Math.round(clampY1 * ky);
    const rw = Math.max(1, Math.round((clampX2 - clampX1) * kx));
    const rh = Math.max(1, Math.round((clampY2 - clampY1) * ky));
    // Destination (where within outW×outH the visible image lands)
    const dx = Math.round((clampX1 - sx1) * kx);
    const dy = Math.round((clampY1 - sy1) * ky);
    const dw = Math.round((clampX2 - clampX1) * kx);
    const dh = Math.round((clampY2 - clampY1) * ky);
    ctx.filter = cssFilterString();
    ctx.drawImage(bmp, rx, ry, rw, rh, dx, dy, dw, dh);
    ctx.filter = 'none';
  }
  bmp.close();
  applySharpness(canvas);
  return canvas;
}

// --- Output actions (Download / PDF / Print) ------------------------------

function setActionsEnabled(enabled) {
  downloadBtn.disabled = !enabled;
  pdfBtn.disabled = !enabled;
  copyBtn.disabled = !enabled;
  printBtn.disabled = !enabled;
  dashboardSaveBtn.disabled = !enabled || !canSaveToDashboard();
  cropBtn.disabled = !enabled;
  rotateLeftBtn.disabled = !enabled;
  rotateRightBtn.disabled = !enabled;
  upscaleBtn.disabled = !enabled;
  denoiseBtn.disabled = !enabled;
  flattenLightBtn.disabled = !enabled;
  autoLevelsBtn.disabled = !enabled;
  cornersBtn.disabled = !enabled;
  resetImgBtn.disabled = !enabled || !originalResultBlob;
  updateUndoRedoButtons();
}

function baseFilename() {
  return currentFileName || 'scan';
}

function defaultFilename(ext = 'png') {
  return `${baseFilename()}_cleaned.${ext}`;
}

async function renderBlobExportCanvas(blob) {
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.filter = cssFilterString();
  ctx.drawImage(bmp, 0, 0);
  ctx.filter = 'none';
  bmp.close();
  applySharpness(canvas);
  return canvas;
}

// Render the current After view to a canvas at the result's native pixel
// density, baking adjustments in. Exports either a crop (if zoomed in) or
// the full image.
async function renderExportCanvas() {
  if (!currentResultBlob) return null;
  const bmp = await createImageBitmap(currentResultBlob);
  const resW = bmp.width;
  const resH = bmp.height;

  const rect = getVisibleSourceRect();
  let rx = 0, ry = 0, rw = resW, rh = resH;
  if (rect) {
    const kx = resW / view.natW;
    const ky = resH / view.natH;
    rx = Math.max(0, Math.round(rect.x * kx));
    ry = Math.max(0, Math.round(rect.y * ky));
    rw = Math.max(1, Math.min(resW - rx, Math.round(rect.w * kx)));
    rh = Math.max(1, Math.min(resH - ry, Math.round(rect.h * ky)));
  }

  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d');
  ctx.filter = cssFilterString();
  ctx.drawImage(bmp, rx, ry, rw, rh, 0, 0, rw, rh);
  ctx.filter = 'none';
  bmp.close();
  applySharpness(canvas);
  return canvas;
}

async function renderFullResultCanvas(blob = currentResultBlob) {
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas;
}

function analyzeCanvasQuality(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const sampleW = Math.min(360, w);
  const sampleH = Math.max(1, Math.round(h * (sampleW / w)));
  const sample = document.createElement('canvas');
  sample.width = sampleW;
  sample.height = sampleH;
  const sctx = sample.getContext('2d');
  sctx.drawImage(canvas, 0, 0, sampleW, sampleH);
  const data = sctx.getImageData(0, 0, sampleW, sampleH).data;
  const luma = new Float32Array(sampleW * sampleH);
  let min = 255, max = 0, darkBorder = 0, borderCount = 0, saturatedBorder = 0;
  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const i = (y * sampleW + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[y * sampleW + x] = v;
      min = Math.min(min, v);
      max = Math.max(max, v);
      if (x < 8 || y < 8 || x >= sampleW - 8 || y >= sampleH - 8) {
        borderCount++;
        if (v < 130) darkBorder++;
        const channelMax = Math.max(r, g, b);
        const channelMin = Math.min(r, g, b);
        if (channelMax - channelMin > 50) saturatedBorder++;
      }
    }
  }

  let lapSum = 0;
  let lapSq = 0;
  let lapCount = 0;
  for (let y = 1; y < sampleH - 1; y++) {
    for (let x = 1; x < sampleW - 1; x++) {
      const i = y * sampleW + x;
      const lap = luma[i - 1] + luma[i + 1] + luma[i - sampleW] + luma[i + sampleW] - 4 * luma[i];
      lapSum += lap;
      lapSq += lap * lap;
      lapCount++;
    }
  }
  const lapMean = lapSum / Math.max(1, lapCount);
  const sharpness = lapSq / Math.max(1, lapCount) - lapMean * lapMean;
  const contrast = max - min;
  const aspect = w / Math.max(1, h);
  const warnings = [];

  if (Math.min(w, h) < 1200) warnings.push({ level: 'warn', text: 'Resolution is low for a statement upload.' });
  if (contrast < 95) warnings.push({ level: 'warn', text: 'Contrast looks low; try Auto Levels or Statement Restore.' });
  if (sharpness < 60) warnings.push({ level: 'warn', text: 'Text may be blurry; try 2x Upscale or Sharpness.' });
  if (darkBorder / Math.max(1, borderCount) > 0.25 || saturatedBorder / Math.max(1, borderCount) > 0.25) {
    warnings.push({ level: 'warn', text: 'Background or objects are visible near the page edge; try Crop or Corner Fix.' });
  }
  if (aspect < 0.55 || aspect > 0.9) warnings.push({ level: 'warn', text: 'Page shape is unusual for a letter statement.' });
  if (!warnings.length) warnings.push({ level: 'pass', text: 'Looks ready: readable contrast, normal page shape, and no obvious border issue.' });
  return warnings;
}

async function refreshQualityChecks() {
  const page = activePage();
  if (!page || !page.resultBlob) {
    qualityPanel.hidden = true;
    qualityList.innerHTML = '';
    return;
  }
  try {
    const canvas = await renderFullResultCanvas(page.resultBlob);
    page.warnings = analyzeCanvasQuality(canvas);
    qualityList.innerHTML = '';
    for (const warning of page.warnings) {
      const li = document.createElement('li');
      li.className = warning.level === 'warn' ? 'is-warning' : 'is-pass';
      li.textContent = warning.text;
      qualityList.appendChild(li);
    }
    qualityPanel.hidden = false;
    renderPageStrip();
  } catch (err) {
    console.warn('Quality check failed:', err);
  }
}

downloadBtn.addEventListener('click', async () => {
  if (!currentResultBlob) return;
  try {
    setStatus('Exporting…', 'is-working');
    const canvas = await renderExportCanvas();
    if (!canvas) { setStatus('Nothing visible to export.', 'is-error'); return; }
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename('png');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Downloaded ${a.download} (${canvas.width}×${canvas.height})`, 'is-success');
  } catch (err) {
    console.error('Download failed:', err);
    setStatus(`Download failed: ${err.message}`, 'is-error');
  }
});

pdfBtn.addEventListener('click', async () => {
  if (!currentResultBlob) return;
  try {
    setStatus('Building PDF…', 'is-working');
    const pages = documentPages.filter((page) => page.resultBlob);
    const searchableTexts = pages.map((page) => page.sourceText || '');
    let canvases;
    if (pages.length > 1) {
      canvases = [];
      for (const page of pages) canvases.push(await renderBlobExportCanvas(page.resultBlob));
    } else {
      const canvas = await renderExportCanvas();
      if (!canvas) { setStatus('Nothing visible to export.', 'is-error'); return; }
      canvases = [canvas];
      if (activePage()) searchableTexts[0] = activePage().sourceText || searchText.value || '';
    }
    const filename = suggestedFilename('pdf');
    const blob = await canvasesToPdfBlob(canvases, {
      title: filename,
      texts: searchableTexts,
      targetSizeMb: statementTargetMb(),
    });
    downloadBlob(blob, filename);
    setStatus(`Downloaded ${filename} (${canvases.length} page${canvases.length === 1 ? '' : 's'})`, 'is-success');
  } catch (err) {
    console.error('PDF export failed:', err);
    setStatus(`PDF export failed: ${err.message}`, 'is-error');
  }
});

copyBtn.addEventListener('click', async () => {
  if (!currentResultBlob) return;
  if (!navigator.clipboard || !window.ClipboardItem) {
    setStatus('Clipboard image copy not supported in this browser.', 'is-error');
    return;
  }
  try {
    setStatus('Copying to clipboard…', 'is-working');
    const canvas = await renderExportCanvas();
    if (!canvas) { setStatus('Nothing visible to copy.', 'is-error'); return; }
    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus(`Copied to clipboard (${canvas.width}×${canvas.height}) — paste into email or document.`, 'is-success');
  } catch (err) {
    console.error('Copy failed:', err);
    setStatus(`Copy failed: ${err.message}`, 'is-error');
  }
});

function canSaveToDashboard() {
  return Boolean(window.parent && window.parent !== window && window.MSFG_SCANNER_SAVE_TARGET);
}

dashboardSaveBtn.addEventListener('click', async () => {
  if (!canSaveToDashboard()) {
    setStatus('Loan-folder save is available when this scanner is mounted inside the dashboard.', 'is-error');
    return;
  }
  try {
    setStatus('Preparing dashboard save payload…', 'is-working');
    const pages = documentPages.filter((page) => page.resultBlob);
    const canvases = [];
    for (const page of pages) canvases.push(await renderBlobExportCanvas(page.resultBlob));
    const filename = suggestedFilename('pdf');
    const blob = await canvasesToPdfBlob(canvases, {
      title: filename,
      texts: pages.map((page) => page.sourceText || ''),
      targetSizeMb: statementTargetMb(),
    });
    window.parent.postMessage({
      type: 'MSFG_SCANNER_SAVE_DOCUMENT',
      filename,
      mimeType: 'application/pdf',
      blob,
    }, window.MSFG_SCANNER_SAVE_TARGET);
    setStatus(`Sent ${filename} to dashboard save handler.`, 'is-success');
  } catch (err) {
    setStatus(`Dashboard save failed: ${err.message}`, 'is-error');
  }
});

// Build the print-window HTML. The filename is user-supplied (from the dropped
// file), so escape it before interpolating. The image src is an in-process
// blob: URL, which is safe to interpolate as-is.
function buildPrintHtml(imageUrl, filename) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Print — ${escapeHtml(filename)}</title>
  <style>
    @page { size: letter; margin: 0.5in; }
    html, body { margin: 0; padding: 0; background: white; }
    .page {
      width: 7.5in;
      height: 10in;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      page-break-after: avoid;
      page-break-inside: avoid;
      break-after: avoid-page;
      break-inside: avoid-page;
    }
    .page img {
      max-width: 7.5in;
      max-height: 10in;
      width: auto;
      height: auto;
      object-fit: contain;
      display: block;
      page-break-inside: avoid;
      break-inside: avoid-page;
    }
    @media screen {
      body { padding: 16px; background: #eee; }
      .page { background: white; box-shadow: 0 2px 8px rgba(0,0,0,.15); margin: 0 auto; }
    }
  </style>
</head>
<body>
  <div class="page"><img src="${imageUrl}" /></div>
</body>
</html>`;
}

printBtn.addEventListener('click', async () => {
  if (!currentResultBlob) return;
  try {
    setStatus('Preparing print…', 'is-working');
    const canvas = await renderExportCanvas();
    if (!canvas) { setStatus('Nothing visible to print.', 'is-error'); return; }
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);

    // Use an off-screen iframe with srcdoc. This avoids popup blockers and
    // document.write (deprecated), and keeps everything same-origin so we
    // can drive print() from the parent frame.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    iframe.srcdoc = buildPrintHtml(url, defaultFilename());

    const cleanup = () => {
      URL.revokeObjectURL(url);
      try { iframe.remove(); } catch (_) { /* ignore */ }
    };

    iframe.addEventListener('load', () => {
      const cw = iframe.contentWindow;
      // Wait for the <img> inside to load before printing, else Chrome may
      // print a blank page.
      const img = cw.document.querySelector('.page img');
      const triggerPrint = () => {
        try { cw.focus(); cw.print(); } catch (err) {
          console.error('Print dispatch failed:', err);
          setStatus(`Print failed: ${err.message}`, 'is-error');
          cleanup();
          return;
        }
        // Best-effort cleanup. afterprint fires in most browsers; fall back
        // to a timer in case it doesn't (e.g. user cancels in Safari).
        cw.addEventListener('afterprint', cleanup, { once: true });
        setTimeout(cleanup, 60_000);
      };
      if (img && img.complete) triggerPrint();
      else if (img) img.addEventListener('load', triggerPrint, { once: true });
      else triggerPrint();
    }, { once: true });

    document.body.appendChild(iframe);
    setStatus(`Printed (${canvas.width}×${canvas.height})`, 'is-success');
  } catch (err) {
    console.error('Print failed:', err);
    setStatus(`Print failed: ${err.message}`, 'is-error');
  }
});

// --- Init ------------------------------------------------------------------

dropzone.classList.add('is-disabled');
initWorker();
