// MSFG Scanner — linked Before/After viewports with zoom + pan.
//
// Both panes share a single view transform (scale + translate). Wheel zooms
// around the pointer, pointer drag pans, double-click toggles fit ↔ 100%.
// The zoom toolbar buttons (Fit / 100% / +/−) drive the same helpers.
//
// The `view` state object is exported as a live mutable reference. Other
// modules (crop, export) read view.tx/ty/scale/natW/natH to map viewport
// coordinates → source-image coordinates. main.js's clearAll also resets
// view.ready/scale/tx/ty directly.
//
// Crop integration: when crop is active on the After viewport, panning is
// blocked. Main passes a predicate via setPanGuard() rather than this module
// importing crop state directly.

// DOM
const beforeImg      = document.getElementById('before-img');
const afterImg       = document.getElementById('after-img');
const beforeViewport = document.getElementById('before-viewport');
const afterViewport  = document.getElementById('after-viewport');
const zoomLevelEl    = document.getElementById('zoom-level');
const zoomToolbar    = document.querySelector('.zoom-toolbar');

// Live mutable view state. Readers rely on the object reference staying
// stable across transforms so they see the latest numbers without re-import.
export const view = {
  scale: 1,
  tx: 0,
  ty: 0,
  natW: 0,   // natural dimensions from beforeImg once loaded
  natH: 0,
  ready: false,
};

// Hook for other features that own the After viewport's pointer (e.g. crop).
// Called with the viewport element that received pointerdown; return true to
// suppress the pan start.
let panGuard = () => false;
export function setPanGuard(fn) { panGuard = fn; }

function applyTransform() {
  const t = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  beforeImg.style.transform = t;
  afterImg.style.transform = t;
  zoomLevelEl.textContent = Math.round(view.scale * 100) + '%';
}

export function fitView() {
  if (!view.ready) return;
  const vpW = beforeViewport.clientWidth;
  const vpH = beforeViewport.clientHeight;
  if (vpW <= 0 || vpH <= 0) return;
  const s = Math.min(vpW / view.natW, vpH / view.natH);
  view.scale = s;
  view.tx = (vpW - view.natW * s) / 2;
  view.ty = (vpH - view.natH * s) / 2;
  applyTransform();
}

function setActualSize() {
  if (!view.ready) return;
  const vpW = beforeViewport.clientWidth;
  const vpH = beforeViewport.clientHeight;
  view.scale = 1;
  view.tx = (vpW - view.natW) / 2;
  view.ty = (vpH - view.natH) / 2;
  applyTransform();
}

function zoomAt(vpX, vpY, factor) {
  if (!view.ready) return;
  const imgX = (vpX - view.tx) / view.scale;
  const imgY = (vpY - view.ty) / view.scale;
  const newScale = Math.max(0.02, Math.min(16, view.scale * factor));
  view.scale = newScale;
  view.tx = vpX - imgX * newScale;
  view.ty = vpY - imgY * newScale;
  applyTransform();
}

function sizeViewportsToImage() {
  if (!view.ready) return;
  const aspect = view.natW / view.natH;
  const w = beforeViewport.clientWidth;
  const h = Math.min(window.innerHeight * 0.7, w / aspect);
  beforeViewport.style.height = h + 'px';
  afterViewport.style.height = h + 'px';
}

function resetView() {
  sizeViewportsToImage();
  fitView();
}

// Rect in source-image coords for the currently visible After region.
// Clamped to image bounds; null if the view isn't ready or intersection empty.
export function getVisibleSourceRect() {
  if (!view.ready) return null;
  const vpW = afterViewport.clientWidth;
  const vpH = afterViewport.clientHeight;
  if (vpW <= 0 || vpH <= 0 || view.scale <= 0) return null;
  const s = view.scale;
  const x1 = Math.max(0, (0 - view.tx) / s);
  const y1 = Math.max(0, (0 - view.ty) / s);
  const x2 = Math.min(view.natW, (vpW - view.tx) / s);
  const y2 = Math.min(view.natH, (vpH - view.ty) / s);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Wheel zoom, pointer-drag pan, double-click toggle on both viewports.
// Crop mode intercepts pointer events on the After viewport via panGuard.
[beforeViewport, afterViewport].forEach((vp) => {
  vp.addEventListener('wheel', (e) => {
    if (!view.ready) return;
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(x, y, factor);
  }, { passive: false });

  let panId = null;
  let panStart = null;

  vp.addEventListener('pointerdown', (e) => {
    if (!view.ready || e.button !== 0) return;
    if (panGuard(vp)) return;  // crop owns pointer on the After viewport
    panId = e.pointerId;
    panStart = { x: e.clientX - view.tx, y: e.clientY - view.ty };
    vp.setPointerCapture(panId);
    beforeViewport.classList.add('is-panning');
    afterViewport.classList.add('is-panning');
  });

  vp.addEventListener('pointermove', (e) => {
    if (e.pointerId !== panId) return;
    view.tx = e.clientX - panStart.x;
    view.ty = e.clientY - panStart.y;
    applyTransform();
  });

  const endPan = (e) => {
    if (e.pointerId !== panId) return;
    try { vp.releasePointerCapture(panId); } catch (_) { /* ignore */ }
    panId = null;
    beforeViewport.classList.remove('is-panning');
    afterViewport.classList.remove('is-panning');
  };
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);

  vp.addEventListener('dblclick', () => {
    if (!view.ready) return;
    const vpW = beforeViewport.clientWidth;
    const vpH = beforeViewport.clientHeight;
    const fitScale = Math.min(vpW / view.natW, vpH / view.natH);
    if (Math.abs(view.scale - fitScale) < 0.01) setActualSize();
    else fitView();
  });
});

zoomToolbar.addEventListener('click', (e) => {
  const action = e.target.dataset && e.target.dataset.zoom;
  if (!action || !view.ready) return;
  if (action === 'fit') fitView();
  else if (action === '100') setActualSize();
  else {
    const vpW = beforeViewport.clientWidth;
    const vpH = beforeViewport.clientHeight;
    const factor = action === 'in' ? 1.25 : 1 / 1.25;
    zoomAt(vpW / 2, vpH / 2, factor);
  }
});

// Dimension tracking driven by After (Upscale/rotate change After's size).
afterImg.addEventListener('load', () => {
  view.natW = afterImg.naturalWidth;
  view.natH = afterImg.naturalHeight;
  view.ready = view.natW > 0 && view.natH > 0;
  if (!view.ready) return;
  beforeImg.style.width = view.natW + 'px';
  beforeImg.style.height = view.natH + 'px';
  afterImg.style.width = view.natW + 'px';
  afterImg.style.height = view.natH + 'px';
  resetView();
});

window.addEventListener('resize', () => {
  if (view.ready) resetView();
});
