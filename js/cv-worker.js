// MSFG Scanner — OpenCV worker.
// Loads opencv.js, runs the enhancement pipeline on each incoming bitmap,
// posts back the result as a PNG Blob.

let cvReady = false;
let cvInitPromise = null;

// Load OpenCV.js and wait for the WASM runtime to initialize.
// The prebuilt 4.10 build from docs.opencv.org wraps Emscripten's MODULARIZE
// pattern in UMD. After importScripts, `cv` may be (a) a factory function,
// (b) a Module object with onRuntimeInitialized, or (c) a thenable — handle all.
function loadOpenCV() {
  if (cvInitPromise) return cvInitPromise;

  cvInitPromise = new Promise((resolve, reject) => {
    try {
      importScripts('../vendor/opencv/opencv.js');
    } catch (err) {
      reject(new Error(`Failed to load opencv.js: ${err.message}`));
      return;
    }

    let candidate = self.cv;

    const finalize = (mod) => {
      self.cv = mod;
      if (typeof mod.Mat !== 'function') {
        reject(new Error('OpenCV loaded but Mat constructor missing'));
        return;
      }
      cvReady = true;
      resolve();
    };

    if (typeof candidate === 'function') {
      try {
        candidate = candidate();
      } catch (err) {
        reject(new Error(`OpenCV factory threw: ${err.message}`));
        return;
      }
    }

    if (candidate && typeof candidate.then === 'function') {
      candidate.then(finalize, (err) => reject(new Error(`OpenCV Promise rejected: ${err}`)));
      return;
    }

    if (candidate && typeof candidate.Mat === 'function') {
      finalize(candidate);
      return;
    }

    if (candidate) {
      const prev = candidate.onRuntimeInitialized;
      candidate.onRuntimeInitialized = () => {
        try { prev && prev(); } catch (_) { /* ignore */ }
        finalize(candidate);
      };
      setTimeout(() => {
        if (!cvReady) reject(new Error('OpenCV init timeout (10s)'));
      }, 10000);
    } else {
      reject(new Error('OpenCV did not attach to self after importScripts'));
    }
  });

  return cvInitPromise;
}

// --- Mat lifecycle ---------------------------------------------------------

// Simple tracker — register every Mat you create, dispose() releases them all.
class MatPool {
  constructor() { this.mats = []; }
  track(mat) { this.mats.push(mat); return mat; }
  dispose() {
    for (const m of this.mats) {
      try { m.delete(); } catch (_) { /* ignore */ }
    }
    this.mats.length = 0;
  }
}

// --- Pipeline --------------------------------------------------------------

// Count zero pixels (ink) in an 8UC1 Mat as a fraction of total pixels.
function inkFraction(mat) {
  const total = mat.rows * mat.cols;
  const data = mat.data;
  let zeros = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0) zeros++;
  return zeros / total;
}

// Choose an odd adaptive-threshold block size scaled to image dimensions
// (~5mm at typical scan DPI).
function adaptiveBlockSize(w, h) {
  let block = Math.round(Math.max(w, h) / 40);
  if (block < 15) block = 15;
  if (block % 2 === 0) block += 1;
  return block;
}

// Preset: Auto
// 1. Green channel (better ink contrast than luminance)
// 2. CLAHE (clipLimit=2.0, tiles 8x8) — local contrast
// 3. Light Gaussian blur
// 4. convertScaleAbs (alpha=1.15, beta=8)
// 5. Otsu — but verify ink fraction is sane (5–35%); if not, the image
//    probably has uneven lighting — fall back to adaptive Gaussian threshold.
// Returns a new Mat (owned by pool).
function runAutoPreset(src, pool) {
  const channels = pool.track(new cv.MatVector());
  cv.split(src, channels);
  const green = pool.track(channels.get(1).clone());

  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  try {
    clahe.apply(green, green);
  } finally {
    clahe.delete();
  }

  cv.GaussianBlur(green, green, new cv.Size(3, 3), 0);
  cv.convertScaleAbs(green, green, 1.15, 8);

  // First try Otsu.
  const otsu = pool.track(new cv.Mat());
  cv.threshold(green, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const frac = inkFraction(otsu);

  // Real documents have ink between ~5% and ~35% of pixels.
  // Outside that range, Otsu likely failed — use adaptive.
  if (frac >= 0.05 && frac <= 0.35) {
    return otsu;
  }

  const adaptive = pool.track(new cv.Mat());
  const block = adaptiveBlockSize(green.cols, green.rows);
  cv.adaptiveThreshold(
    green, adaptive, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY,
    block, 10,
  );
  return adaptive;
}

// Convert an 8UC1 / 8UC3 / 8UC4 Mat to ImageData.
function matToImageData(mat) {
  const w = mat.cols;
  const h = mat.rows;
  const channels = mat.channels();
  const imageData = new ImageData(w, h);
  const out = imageData.data;

  if (channels === 1) {
    const src = mat.data;
    for (let i = 0, j = 0; i < src.length; i++, j += 4) {
      const v = src[i];
      out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
    }
  } else if (channels === 4) {
    out.set(mat.data);
  } else if (channels === 3) {
    const src = mat.data;
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      out[j] = src[i]; out[j + 1] = src[i + 1]; out[j + 2] = src[i + 2]; out[j + 3] = 255;
    }
  } else {
    throw new Error(`Unsupported channel count: ${channels}`);
  }
  return imageData;
}

function selectPreset(name) {
  switch (name) {
    case 'auto':
    default:
      return runAutoPreset;
  }
}

async function processBitmap(id, bitmap, options) {
  const w = bitmap.width;
  const h = bitmap.height;
  const t0 = performance.now();

  // Rasterize bitmap to ImageData (cannot pass ImageBitmap directly to cv).
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const srcImageData = ctx.getImageData(0, 0, w, h);
  bitmap.close();

  postMessage({ id, type: 'progress', stage: 'enhance' });

  const pool = new MatPool();
  let blob;
  try {
    const src = pool.track(cv.matFromImageData(srcImageData));
    const presetFn = selectPreset(options.preset);
    const result = presetFn(src, pool);

    const resultImageData = matToImageData(result);
    const outCanvas = new OffscreenCanvas(result.cols, result.rows);
    const outCtx = outCanvas.getContext('2d');
    outCtx.putImageData(resultImageData, 0, 0);
    blob = await outCanvas.convertToBlob({ type: 'image/png' });
  } finally {
    pool.dispose();
  }

  const elapsedMs = Math.round(performance.now() - t0);
  return { blob, width: w, height: h, elapsedMs };
}

// --- Message dispatch ------------------------------------------------------

self.addEventListener('message', async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      await loadOpenCV();
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', code: 'INIT_FAILED', message: err.message, recoverable: false });
    }
    return;
  }

  if (msg.type === 'process') {
    const { id, bitmap, options } = msg;
    try {
      if (!cvReady) await loadOpenCV();
      const { blob, width, height, elapsedMs } = await processBitmap(id, bitmap, options);
      postMessage({ id, type: 'result', blob, width, height, elapsedMs });
    } catch (err) {
      console.error('[cv-worker] process failed:', err);
      postMessage({
        id,
        type: 'error',
        code: 'PIPELINE_FAILED',
        message: err.message || String(err),
        recoverable: false,
      });
    }
    return;
  }
});
