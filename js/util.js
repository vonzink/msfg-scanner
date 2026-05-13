// MSFG Scanner — pure utilities.
// No module state, no DOM access — just functions that take inputs and
// return outputs. Shared across main.js and any future module splits.

// --- Blob-URL helpers ------------------------------------------------------
// Set <img>.src to a new blob URL, revoking the prior one so we don't leak
// memory when rotating/upscaling/denoising through multiple results.

export function setImgSrc(img, blob) {
  const prev = img.getAttribute('src');
  img.src = URL.createObjectURL(blob);
  if (prev && prev.startsWith('blob:')) {
    // Defer one tick so the browser latches onto the new src first.
    queueMicrotask(() => URL.revokeObjectURL(prev));
  }
}

export function clearImgSrc(img) {
  const prev = img.getAttribute('src');
  img.removeAttribute('src');
  if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
}

// HTML-escape untrusted strings before interpolating into markup (print window).
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Canvas → Blob. Single wrapper around the callback-style canvas.toBlob.
// Default: PNG (lossless). For JPEG pass 'image/jpeg' + a 0-1 quality.
// Throws on encoder failure with a descriptive message for the caller.
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error(`${type} encode failed`));
    }, type, quality);
  });
}

function escapePdfLiteral(s) {
  return String(s)
    .replace(/[\\()]/g, '\\$&')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function pdfTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    'D:',
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function concatPdfChunks(chunks, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pageLayoutForCanvas(canvas) {
  const imageAspect = canvas.width / Math.max(1, canvas.height);
  const portrait = imageAspect <= 1;
  const pageW = portrait ? 612 : 792; // US Letter in PDF points.
  const pageH = portrait ? 792 : 612;
  const margin = 18; // 0.25in margin keeps the page feeling like a saved PDF.
  const fitW = pageW - margin * 2;
  const fitH = pageH - margin * 2;
  let drawW = fitW;
  let drawH = drawW / imageAspect;
  if (drawH > fitH) {
    drawH = fitH;
    drawW = drawH * imageAspect;
  }
  const drawX = (pageW - drawW) / 2;
  const drawY = (pageH - drawH) / 2;
  return { pageW, pageH, drawW, drawH, drawX, drawY };
}

function buildInvisibleText(text, pageW) {
  const clean = escapePdfLiteral(String(text || '').slice(0, 20_000));
  if (!clean) return '';
  const maxChars = 220;
  const lines = [];
  for (let i = 0; i < clean.length; i += maxChars) {
    lines.push(clean.slice(i, i + maxChars));
  }
  const chunks = ['BT\n/F1 8 Tf\n3 Tr\n24 24 Td\n'];
  for (const line of lines.slice(0, 80)) {
    chunks.push(`(${line}) Tj\n0 10 Td\n`);
  }
  chunks.push('ET\n');
  return chunks.join('');
}

async function encodeCanvases(canvases, targetBytes) {
  const qualities = targetBytes ? [0.94, 0.88, 0.82, 0.74, 0.66, 0.58] : [0.94];
  let best = null;
  for (const quality of qualities) {
    const images = [];
    let total = 0;
    for (const canvas of canvases) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      images.push(bytes);
      total += bytes.length;
    }
    best = { images, quality, total };
    if (!targetBytes || total <= targetBytes) break;
  }
  return best;
}

// Canvas list -> image-backed PDF. Each page preserves the cleaned result as a
// high-resolution image. Optional text is embedded invisibly so PDFs that have
// extracted or manually-entered text can be searched without changing pixels.
export async function canvasesToPdfBlob(canvases, options = {}) {
  if (!canvases.length) throw new Error('No pages to export');
  const title = options.title || 'statement';
  const texts = options.texts || [];
  const targetBytes = options.targetSizeMb ? options.targetSizeMb * 1024 * 1024 : 0;
  const { images } = await encodeCanvases(canvases, targetBytes);

  const pageCount = canvases.length;
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i);
  const imageIds = Array.from({ length: pageCount }, (_, i) => 3 + pageCount + i);
  const contentIds = Array.from({ length: pageCount }, (_, i) => 3 + pageCount * 2 + i);
  const fontId = 3 + pageCount * 3;
  const infoId = fontId + 1;
  const objectCount = infoId;

  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let byteLength = 0;

  const pushString = (s) => {
    const bytes = enc.encode(s);
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const pushBytes = (bytes) => {
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const beginObject = (id) => {
    offsets[id] = byteLength;
    pushString(`${id} 0 obj\n`);
  };

  pushString('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  beginObject(1);
  pushString('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  pushString(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`);

  canvases.forEach((canvas, index) => {
    const { pageW, pageH } = pageLayoutForCanvas(canvas);
    beginObject(pageIds[index]);
    pushString([
      '<< /Type /Page /Parent 2 0 R ',
      `/MediaBox [0 0 ${pageW} ${pageH}] `,
      `/Resources << /XObject << /Im${index} ${imageIds[index]} 0 R >> /Font << /F1 ${fontId} 0 R >> >> `,
      `/Contents ${contentIds[index]} 0 R >>\n`,
      'endobj\n',
    ].join(''));
  });

  canvases.forEach((canvas, index) => {
    const jpegBytes = images[index];
    beginObject(imageIds[index]);
    pushString([
      '<< /Type /XObject /Subtype /Image ',
      `/Width ${canvas.width} /Height ${canvas.height} `,
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 ',
      `/Filter /DCTDecode /Length ${jpegBytes.length} >>\n`,
      'stream\n',
    ].join(''));
    pushBytes(jpegBytes);
    pushString('\nendstream\nendobj\n');
  });

  canvases.forEach((canvas, index) => {
    const { pageW, drawW, drawH, drawX, drawY } = pageLayoutForCanvas(canvas);
    const content = [
      'q\n',
      `${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm\n`,
      `/Im${index} Do\n`,
      'Q\n',
      buildInvisibleText(texts[index], pageW),
    ].join('');
    beginObject(contentIds[index]);
    pushString(`<< /Length ${enc.encode(content).length} >>\nstream\n`);
    pushString(content);
    pushString('endstream\nendobj\n');
  });

  beginObject(fontId);
  pushString('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  beginObject(infoId);
  pushString([
    '<< ',
    `/Title (${escapePdfLiteral(title)}) `,
    '/Producer (MSFG Scanner) ',
    `/CreationDate (${pdfTimestamp()}) `,
    '>>\nendobj\n',
  ].join(''));

  const xrefOffset = byteLength;
  pushString(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objectCount; i++) {
    pushString(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushString(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob([concatPdfChunks(chunks, byteLength)], { type: 'application/pdf' });
}

// Back-compat wrapper for single-page exports.
export async function canvasToPdfBlob(canvas, title = 'statement', options = {}) {
  return canvasesToPdfBlob([canvas], {
    ...options,
    title,
    texts: options.text ? [options.text] : options.texts,
  });
}

// Downscale an ImageBitmap so its pixel count fits within maxMP. Returns the
// original bitmap if it's already within budget, otherwise returns a new
// bitmap (and closes the original). Keeps aspect ratio.
export async function downscaleBitmapToBudget(bitmap, maxMP) {
  const mp = bitmap.width * bitmap.height;
  if (mp <= maxMP) return bitmap;
  const scale = Math.sqrt(maxMP / mp);
  const next = await createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale),
    resizeHeight: Math.round(bitmap.height * scale),
    resizeQuality: 'high',
  });
  bitmap.close();
  return next;
}

// Build a 3×3 unsharp-mask-style kernel for a given amount (0–100).
// Used by both the live SVG preview filter and the export-time canvas
// convolution so they stay numerically in sync.
//   identity (amount=0): center=1, edge=0
//   amount>0:            center=1+4a, edge=-a, where a = amount/100
export function buildSharpenKernel(amount) {
  const a = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
  if (a <= 0) {
    return { amount: 0, center: 1, edge: 0, svgMatrix: '0 0 0 0 1 0 0 0 0' };
  }
  const center = 1 + 4 * a;
  const edge = -a;
  return {
    amount: a,
    center,
    edge,
    svgMatrix: `0 ${edge} 0 ${edge} ${center} ${edge} 0 ${edge} 0`,
  };
}
