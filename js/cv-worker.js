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

// Preset: Document Color — preserves color while enhancing contrast and
// sharpness. Converts BGR→YCrCb, runs CLAHE on Y only, converts back, then
// mild convertScaleAbs for pop. Returns RGB Mat.
function runDocumentColorPreset(src, pool) {
  // src is RGBA. Strip alpha to RGB.
  const rgb = pool.track(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

  const ycrcb = pool.track(new cv.Mat());
  cv.cvtColor(rgb, ycrcb, cv.COLOR_RGB2YCrCb);

  const channels = pool.track(new cv.MatVector());
  cv.split(ycrcb, channels);
  const y = pool.track(channels.get(0).clone());
  const cr = pool.track(channels.get(1).clone());
  const cb = pool.track(channels.get(2).clone());

  const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
  try {
    clahe.apply(y, y);
  } finally {
    clahe.delete();
  }

  const merged = pool.track(new cv.MatVector());
  merged.push_back(y);
  merged.push_back(cr);
  merged.push_back(cb);
  const mergedMat = pool.track(new cv.Mat());
  cv.merge(merged, mergedMat);

  const outRgb = pool.track(new cv.Mat());
  cv.cvtColor(mergedMat, outRgb, cv.COLOR_YCrCb2RGB);
  cv.convertScaleAbs(outRgb, outRgb, 1.08, 4);
  return outRgb;
}

// Preset: Photo — very light touch for photos. CLAHE on luminance at a low
// clip limit, no thresholding, full color preserved.
function runPhotoPreset(src, pool) {
  const rgb = pool.track(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

  const ycrcb = pool.track(new cv.Mat());
  cv.cvtColor(rgb, ycrcb, cv.COLOR_RGB2YCrCb);
  const channels = pool.track(new cv.MatVector());
  cv.split(ycrcb, channels);
  const y = pool.track(channels.get(0).clone());
  const cr = pool.track(channels.get(1).clone());
  const cb = pool.track(channels.get(2).clone());

  const clahe = new cv.CLAHE(1.2, new cv.Size(16, 16));
  try {
    clahe.apply(y, y);
  } finally {
    clahe.delete();
  }

  const merged = pool.track(new cv.MatVector());
  merged.push_back(y);
  merged.push_back(cr);
  merged.push_back(cb);
  const mergedMat = pool.track(new cv.Mat());
  cv.merge(merged, mergedMat);

  const outRgb = pool.track(new cv.Mat());
  cv.cvtColor(mergedMat, outRgb, cv.COLOR_YCrCb2RGB);
  return outRgb;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function orderQuad(points) {
  const bySum = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const remaining = [bySum[1], bySum[2]];
  const [tr, bl] = remaining[0].x > remaining[1].x
    ? [remaining[0], remaining[1]]
    : [remaining[1], remaining[0]];
  return [tl, tr, br, bl];
}

function pointsFromApprox(approx) {
  const pts = [];
  for (let i = 0; i < approx.rows; i++) {
    pts.push({
      x: approx.data32S[i * 2],
      y: approx.data32S[i * 2 + 1],
    });
  }
  return pts;
}

function findDocumentQuad(src, pool) {
  const gray = pool.track(new cv.Mat());
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = pool.track(new cv.Mat());
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  const edges = pool.track(new cv.Mat());
  cv.Canny(blurred, edges, 40, 130);

  const kernel = pool.track(cv.Mat.ones(5, 5, cv.CV_8U));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
  cv.dilate(edges, edges, kernel);

  const contours = pool.track(new cv.MatVector());
  const hierarchy = pool.track(new cv.Mat());
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const imageArea = src.cols * src.rows;
  let best = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const approx = new cv.Mat();
    try {
      const area = Math.abs(cv.contourArea(contour));
      if (area < imageArea * 0.18 || area <= bestArea) continue;

      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, perimeter * 0.025, true);
      if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;

      const pts = orderQuad(pointsFromApprox(approx));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      const boundsArea = (maxX - minX) * (maxY - minY);
      if (boundsArea > imageArea * 0.96) continue;

      const w = Math.max(dist(pts[0], pts[1]), dist(pts[2], pts[3]));
      const h = Math.max(dist(pts[1], pts[2]), dist(pts[3], pts[0]));
      const aspect = w / Math.max(1, h);
      if (aspect < 0.35 || aspect > 2.4) continue;

      best = pts;
      bestArea = area;
    } finally {
      approx.delete();
      contour.delete();
    }
  }

  return best;
}

function warpDocumentIfFound(src, pool) {
  const quad = findDocumentQuad(src, pool);
  if (!quad) return null;

  const width = Math.max(dist(quad[0], quad[1]), dist(quad[2], quad[3]));
  const height = Math.max(dist(quad[1], quad[2]), dist(quad[3], quad[0]));
  const outW = Math.max(64, Math.round(width));
  const outH = Math.max(64, Math.round(height));
  if (outW > src.cols * 0.94 && outH > src.rows * 0.94) return null;

  const srcQuad = pool.track(cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]));
  const dstQuad = pool.track(cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW - 1, 0,
    outW - 1, outH - 1,
    0, outH - 1,
  ]));
  const transform = pool.track(cv.getPerspectiveTransform(srcQuad, dstQuad));
  const out = pool.track(new cv.Mat());
  cv.warpPerspective(
    src,
    out,
    transform,
    new cv.Size(outW, outH),
    cv.INTER_CUBIC,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255),
  );
  return out;
}

function findBrightDocumentRect(src, pool) {
  const rgb = pool.track(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const hsv = pool.track(new cv.Mat());
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const hsvChannels = pool.track(new cv.MatVector());
  cv.split(hsv, hsvChannels);
  const sat = hsvChannels.get(1);
  const val = hsvChannels.get(2);

  const lowSaturation = pool.track(new cv.Mat());
  const highValue = pool.track(new cv.Mat());
  const mask = pool.track(new cv.Mat());
  cv.threshold(sat, lowSaturation, 30, 255, cv.THRESH_BINARY_INV);
  cv.threshold(val, highValue, 120, 255, cv.THRESH_BINARY);
  cv.bitwise_and(lowSaturation, highValue, mask);
  sat.delete();
  val.delete();

  const kernelSize = Math.max(15, Math.round(Math.max(src.cols, src.rows) / 70) | 1);
  const kernel = pool.track(cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);

  const contours = pool.track(new cv.MatVector());
  const hierarchy = pool.track(new cv.Mat());
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const imageArea = src.cols * src.rows;
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    try {
      const area = Math.abs(cv.contourArea(contour));
      if (area < imageArea * 0.18 || area <= bestArea) continue;
      const rect = cv.boundingRect(contour);
      const rectArea = rect.width * rect.height;
      const aspect = rect.width / Math.max(1, rect.height);
      if (rectArea > imageArea * 0.96) continue;
      if (rectArea < imageArea * 0.25 || aspect < 0.35 || aspect > 1.45) continue;
      best = rect;
      bestArea = area;
    } finally {
      contour.delete();
    }
  }

  if (!best) return null;
  const pad = Math.round(Math.max(best.width, best.height) * 0.012);
  const x = Math.max(0, best.x - pad);
  const y = Math.max(0, best.y - pad);
  const right = Math.min(src.cols, best.x + best.width + pad);
  const bottom = Math.min(src.rows, best.y + best.height + pad);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function cropDocumentBoundsIfFound(src, pool) {
  const rect = findBrightDocumentRect(src, pool);
  if (!rect) return null;
  const roi = src.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
  const out = pool.track(roi.clone());
  roi.delete();
  return out;
}

function whiteBalanceRgb(src, pool) {
  const channels = pool.track(new cv.MatVector());
  cv.split(src, channels);

  const sourceChannels = [channels.get(0), channels.get(1), channels.get(2)];
  const means = sourceChannels.map((ch) => Math.max(1, cv.mean(ch)[0]));
  const target = (means[0] + means[1] + means[2]) / 3;

  const balancedChannels = pool.track(new cv.MatVector());
  for (let i = 0; i < sourceChannels.length; i++) {
    const ch = pool.track(sourceChannels[i].clone());
    const scale = Math.max(0.75, Math.min(1.3, target / means[i]));
    cv.convertScaleAbs(ch, ch, scale, 0);
    balancedChannels.push_back(ch);
    sourceChannels[i].delete();
  }

  const out = pool.track(new cv.Mat());
  cv.merge(balancedChannels, out);
  return out;
}

// Preset: Statement Restore — designed for photographed or scanned mortgage
// statements. It preserves the statement data as pixels, while using page-edge
// detection, perspective correction, white balance, local contrast, and
// sharpening to make the result resemble a clean saved statement.
function runStatementPreset(src, pool) {
  const documentMat = warpDocumentIfFound(src, pool) || cropDocumentBoundsIfFound(src, pool) || src;

  const rgb = pool.track(new cv.Mat());
  cv.cvtColor(documentMat, rgb, cv.COLOR_RGBA2RGB);
  const balanced = whiteBalanceRgb(rgb, pool);

  const lab = pool.track(new cv.Mat());
  cv.cvtColor(balanced, lab, cv.COLOR_RGB2Lab);

  const channels = pool.track(new cv.MatVector());
  cv.split(lab, channels);
  const l = pool.track(channels.get(0).clone());
  const a = pool.track(channels.get(1).clone());
  const b = pool.track(channels.get(2).clone());

  const clahe = new cv.CLAHE(1.8, new cv.Size(8, 8));
  try {
    clahe.apply(l, l);
  } finally {
    clahe.delete();
  }
  cv.convertScaleAbs(l, l, 1.08, 6);

  const merged = pool.track(new cv.MatVector());
  merged.push_back(l);
  merged.push_back(a);
  merged.push_back(b);
  const mergedLab = pool.track(new cv.Mat());
  cv.merge(merged, mergedLab);

  const outRgb = pool.track(new cv.Mat());
  cv.cvtColor(mergedLab, outRgb, cv.COLOR_Lab2RGB);

  const blur = pool.track(new cv.Mat());
  cv.GaussianBlur(outRgb, blur, new cv.Size(0, 0), 1.0);

  const sharp = pool.track(new cv.Mat());
  cv.addWeighted(outRgb, 1.45, blur, -0.45, 0, sharp);
  cv.convertScaleAbs(sharp, sharp, 1.03, 2);
  return sharp;
}

// Preset: None — just strip alpha. Useful if user only wants to use the
// slider adjustments / crop / rotate without any auto-enhancement.
function runNonePreset(src, pool) {
  const rgb = pool.track(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  return rgb;
}

function selectPreset(name) {
  switch (name) {
    case 'statement':      return runStatementPreset;
    case 'document-color': return runDocumentColorPreset;
    case 'photo':          return runPhotoPreset;
    case 'none':           return runNonePreset;
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

async function warpBitmap(id, bitmap, points) {
  const w = bitmap.width;
  const h = bitmap.height;
  const t0 = performance.now();
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const srcImageData = ctx.getImageData(0, 0, w, h);
  bitmap.close();

  const ordered = orderQuad(points);
  const outW = Math.max(16, Math.round(Math.max(dist(ordered[0], ordered[1]), dist(ordered[2], ordered[3]))));
  const outH = Math.max(16, Math.round(Math.max(dist(ordered[1], ordered[2]), dist(ordered[3], ordered[0]))));

  const pool = new MatPool();
  let blob;
  try {
    const src = pool.track(cv.matFromImageData(srcImageData));
    const srcQuad = pool.track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      ordered[0].x, ordered[0].y,
      ordered[1].x, ordered[1].y,
      ordered[2].x, ordered[2].y,
      ordered[3].x, ordered[3].y,
    ]));
    const dstQuad = pool.track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      outW - 1, 0,
      outW - 1, outH - 1,
      0, outH - 1,
    ]));
    const transform = pool.track(cv.getPerspectiveTransform(srcQuad, dstQuad));
    const out = pool.track(new cv.Mat());
    cv.warpPerspective(
      src,
      out,
      transform,
      new cv.Size(outW, outH),
      cv.INTER_CUBIC,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );
    const resultImageData = matToImageData(out);
    const outCanvas = new OffscreenCanvas(outW, outH);
    outCanvas.getContext('2d').putImageData(resultImageData, 0, 0);
    blob = await outCanvas.convertToBlob({ type: 'image/png' });
  } finally {
    pool.dispose();
  }
  return { blob, width: outW, height: outH, elapsedMs: Math.round(performance.now() - t0) };
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

  if (msg.type === 'warp') {
    const { id, bitmap, points } = msg;
    try {
      if (!cvReady) await loadOpenCV();
      const { blob, width, height, elapsedMs } = await warpBitmap(id, bitmap, points);
      postMessage({ id, type: 'result', blob, width, height, elapsedMs });
    } catch (err) {
      console.error('[cv-worker] warp failed:', err);
      postMessage({
        id,
        type: 'error',
        code: 'WARP_FAILED',
        message: err.message || String(err),
        recoverable: false,
      });
    }
    return;
  }
});
