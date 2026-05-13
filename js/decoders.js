// MSFG Scanner — format detection + lazy decoders for PDF, HEIC, and SVG.
// These are the only code paths that need third-party libraries; the libraries
// (pdf.js, heic2any) are vendored locally and lazy-loaded the first time a
// matching file is dropped.

import { canvasToBlob } from './util.js';

// Third-party decoders are vendored locally (lazy-loaded on first PDF/HEIC drop).
// Paths are resolved relative to the HTML entry point.
const PDFJS_URL = 'vendor/pdfjs/pdf.min.mjs';
const PDFJS_WORKER_URL = 'vendor/pdfjs/pdf.worker.min.mjs';
const HEIC2ANY_URL = 'vendor/heic2any/heic2any.min.js';

// --- Format detection ------------------------------------------------------

const MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png:  [0x89, 0x50, 0x4E, 0x47],
  pdf:  [0x25, 0x50, 0x44, 0x46],  // %PDF
};

// HEIC/HEIF files start with a `ftyp` box (bytes 4-7) followed by a brand
// like heic, heix, mif1, msf1, heis, heim, hevc, hevx.
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'heis', 'heim', 'hevc', 'hevx', 'heif']);

export async function detectFormat(file) {
  // SVG is XML-based — MIME/extension check first since magic bytes are unreliable
  // (file can start with BOM, whitespace, XML prolog, comments, or <svg directly).
  const nameLower = (file.name || '').toLowerCase();
  if (file.type === 'image/svg+xml' || nameLower.endsWith('.svg')) {
    return 'svg';
  }

  const buf = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  for (const [name, magic] of Object.entries(MAGIC_BYTES)) {
    if (magic.every((b, i) => buf[i] === b)) return name;
  }
  // Check HEIC: bytes 4-7 should be "ftyp", then bytes 8-11 are brand.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return 'heic';
  }
  // SVG content scan (handles mislabeled/renamed files)
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (/<svg[\s>]/i.test(text)) return 'svg';
  } catch (_) { /* ignore */ }
  return null;
}

// --- PDF decoder (pdf.js, lazy) -------------------------------------------

let pdfjsPromise = null;
function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  // Resolve paths against the document so relative URLs work whether the page
  // is served from / or a subpath.
  const base = document.baseURI;
  const mainUrl = new URL(PDFJS_URL, base).href;
  const workerUrl = new URL(PDFJS_WORKER_URL, base).href;
  pdfjsPromise = import(/* @vite-ignore */ mainUrl).then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    return mod;
  });
  return pdfjsPromise;
}

async function renderPdfPageToFile(page, file, pageNumber) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await canvasToBlob(canvas);
  const suffix = pageNumber > 1 ? `_page-${String(pageNumber).padStart(2, '0')}` : '';
  return new File([blob], file.name.replace(/\.pdf$/i, `${suffix}.png`), { type: 'image/png' });
}

async function extractPdfPageText(page) {
  try {
    const content = await page.getTextContent();
    return content.items
      .map((item) => item.str || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (_) {
    return '';
  }
}

// Render every page of a PDF blob to image Files. Text extraction is best-effort
// and only works for PDFs that already contain text; image-only scans return
// blank text and can still use the manual searchable-text box.
export async function decodePdfPages(file) {
  const pdfjs = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const [imageFile, text] = await Promise.all([
        renderPdfPageToFile(page, file, i),
        extractPdfPageText(page),
      ]);
      pages.push({ imageFile, text, pageNumber: i, pageCount: doc.numPages });
    }
  } finally {
    try { doc.destroy(); } catch (_) { /* ignore */ }
  }
  return pages;
}

// Back-compat wrapper used by older call sites.
export async function decodePdfFirstPage(file) {
  const pages = await decodePdfPages(file);
  return pages[0]?.imageFile;
}

// --- HEIC decoder (heic2any, lazy) ----------------------------------------

let heic2anyPromise = null;
function loadHeic2any() {
  if (heic2anyPromise) return heic2anyPromise;
  heic2anyPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(HEIC2ANY_URL, document.baseURI).href;
    s.async = true;
    s.onload = () => {
      if (typeof window.heic2any === 'function') resolve(window.heic2any);
      else reject(new Error('heic2any loaded but function missing'));
    };
    s.onerror = () => reject(new Error('Failed to load heic2any'));
    document.head.appendChild(s);
  });
  return heic2anyPromise;
}

export async function decodeHeic(file) {
  const heic2any = await loadHeic2any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
}

// --- SVG rasterizer --------------------------------------------------------

// Rasterize an SVG to a PNG File using its declared dimensions (or viewBox),
// scaled up to 2× for crispness and capped at 4000px on the longest side.
export async function decodeSvg(file) {
  const text = await file.text();
  let w = 0, h = 0;
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    w = parseFloat(svg.getAttribute('width')) || 0;
    h = parseFloat(svg.getAttribute('height')) || 0;
    if (!w || !h) {
      const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb.every(Number.isFinite)) {
        w = w || vb[2];
        h = h || vb[3];
      }
    }
  } catch (_) { /* fall through */ }
  if (!w || !h) { w = 2000; h = 2000; }
  const scale = Math.min(2, 4000 / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('SVG load failed'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // white background for transparent SVGs
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    const blob = await canvasToBlob(canvas);
    return new File([blob], file.name.replace(/\.svg$/i, '.png'), { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
