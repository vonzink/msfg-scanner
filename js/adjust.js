// MSFG Scanner — slider-driven adjustments (brightness/contrast/saturation/sharpness).
//
// Two rendering paths share this state:
//   - Live preview uses CSS filters on the <img>, plus the SVG feConvolveMatrix
//     for sharpness.
//   - Export re-bakes the same values onto a canvas via ctx.filter + a 3×3
//     convolution (applySharpness). Both paths read from the same `adjust`
//     object so they can't drift.
//
// This module owns the slider DOM (#adj-brightness/contrast/saturate/sharpness,
// #adj-reset, the .adj-value output spans) and the SVG filter matrix node.
// The after-image element is shared with viewport.js but adjustments own the
// CSS `filter` property on it.

import { buildSharpenKernel } from './util.js';

// DOM
const adjBrightness = document.getElementById('adj-brightness');
const adjContrast   = document.getElementById('adj-contrast');
const adjSaturate   = document.getElementById('adj-saturate');
const adjSharpness  = document.getElementById('adj-sharpness');
const adjReset      = document.getElementById('adj-reset');
const afterImg      = document.getElementById('after-img');
const sharpenMatrix = document.getElementById('sc-sharpen-matrix');

// State. Mutated by the sliders, read by both the preview and export paths.
const adjust = {
  brightness: 100,  // 50-150 (%)
  contrast:   100,  // 50-200 (%)
  saturate:   100,  // 0-200 (%)
  sharpness:    0,  // 0-100 (subjective, mapped to canvas unsharp-mask amount)
};

// Build the CSS filter string for both live preview and ctx.filter at export.
export function cssFilterString() {
  return `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%)`;
}

// Push the current adjust state into the live preview: CSS filter on the
// after-image + sharpness kernel on the SVG feConvolveMatrix.
function applyAdjustmentsPreview() {
  const css = cssFilterString();
  const sharpen = adjust.sharpness > 0 ? ' url(#sc-sharpen)' : '';
  afterImg.style.filter = css + sharpen;
  if (sharpenMatrix) {
    sharpenMatrix.setAttribute('kernelMatrix', buildSharpenKernel(adjust.sharpness).svgMatrix);
  }
}

// Wire one slider → adjust[key], refresh its readout span, re-apply preview.
function wireSlider(el, key) {
  el.addEventListener('input', () => {
    adjust[key] = Number(el.value);
    const out = document.querySelector(`.adj-value[data-for="${el.id}"]`);
    if (out) out.textContent = `${adjust[key]}%`;
    applyAdjustmentsPreview();
  });
}
wireSlider(adjBrightness, 'brightness');
wireSlider(adjContrast,   'contrast');
wireSlider(adjSaturate,   'saturate');
wireSlider(adjSharpness,  'sharpness');

// Restore all sliders + state to defaults (100/100/100/0). Called on reset
// button clicks and on every new file.
export function resetAdjustmentsState() {
  adjust.brightness = 100; adjBrightness.value = 100;
  adjust.contrast   = 100; adjContrast.value   = 100;
  adjust.saturate   = 100; adjSaturate.value   = 100;
  adjust.sharpness  = 0;   adjSharpness.value  = 0;
  document.querySelectorAll('.adj-value').forEach((el) => {
    const src = document.getElementById(el.dataset.for);
    if (src) el.textContent = `${src.value}%`;
  });
  applyAdjustmentsPreview();
}
adjReset.addEventListener('click', resetAdjustmentsState);

// Unsharp-mask-style sharpness via a 3×3 convolution. Reads kernel values
// from the shared builder so the export matches the live SVG preview.
// Skipped when amount = 0. Operates in place on the canvas.
export function applySharpness(canvas) {
  const { amount, center, edge } = buildSharpenKernel(adjust.sharpness);
  if (amount <= 0) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data;
  const o = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        o[i] = s[i]; o[i+1] = s[i+1]; o[i+2] = s[i+2]; o[i+3] = s[i+3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v =
          s[i + c] * center +
          s[i + c - 4] * edge +
          s[i + c + 4] * edge +
          s[i + c - w * 4] * edge +
          s[i + c + w * 4] * edge;
        o[i + c] = Math.max(0, Math.min(255, v));
      }
      o[i + 3] = s[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}
