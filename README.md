# MSFG Scanner

Browser-based document cleanup tool. Drop a scan or photo, get a cleaner
version back — with live adjustments, crop, rotate, upscale, denoise, and
multi-page statement PDF/print output.

Runs entirely client-side. No uploads, no server processing, no accounts.

## Running locally

Any static HTTP server works. The app uses ES modules and a Web Worker, so
`file://` won't work — you need a real server.

```bash
# Python
python3 -m http.server 8080

# or Node
npx serve -l 8080
```

Open http://localhost:8080 and drop a file.

## Supported input

| Format | Max size | Notes |
|--------|----------|-------|
| JPG / PNG | 50 MB | Native browser decode |
| PDF | 50 MB | All pages rendered at 2× via pdf.js |
| HEIC / HEIF | 50 MB | Converted to JPEG via heic2any |
| SVG | 50 MB | Rasterized to PNG, capped at 4000px on the longest side |

Images over **4 megapixels** are downscaled before processing.

## Output

- **Download** — PNG of the current After view (respects zoom crop).
- **PDF** — image-backed statement PDF. Single-page files export the current
  After view; multi-page/batch files export all processed pages.
- **Copy** — PNG to clipboard for pasting into email, Word, Slack, etc.
- **Print** — single letter-size page, 0.5" margins, fit-to-page.

## Presets

| Preset | What it does |
|--------|--------------|
| Original | No enhancement. Use sliders/crop/rotate only. |
| Statement Restore (AI Enhanced) | Preserves statement content while auto-detecting the page, correcting perspective when possible, balancing paper color, improving contrast, and sharpening text. |
| Document (Color) | CLAHE on luminance, mild contrast bump. Keeps color. |
| Document B&W (Auto) | Green channel + CLAHE + Otsu (fallback to adaptive if Otsu fails). |
| Photo | Very light CLAHE, full color preserved. |

## Statement restoration

The Statement Restore preset is meant for legitimate cleanup of photographed or
scanned statements like mortgage statements. It does not fabricate, rewrite, or
change statement values. It keeps the visible document as pixels and uses local
image processing to make the output look closer to a clean saved statement.

The **PDF** action exports image-backed letter-size pages, so the file can be
saved or uploaded where a statement PDF is expected.

Additional statement tools:

- **Corner Fix** — manually drag four handles to the real paper corners and
  rebuild the page with perspective correction.
- **Flatten Light** — reduces shadows, folds, and uneven exposure.
- **Quality checks** — flags likely upload problems such as visible background,
  low contrast, low resolution, blur, or odd page shape.
- **Search text layer** — embeds extracted PDF text or manually pasted OCR text
  invisibly behind the image, making the exported PDF searchable without
  changing visible values.
- **Apply All / page strip** — process multi-page PDFs or multiple dropped
  files and export them as a combined statement PDF.
- **Undo / Redo** — keeps recent image operations reversible.
- **Statement upload profile** — uses letter-sized PDF pages, filename controls,
  and optional target-size compression.
- **Save to Loan Folder** — disabled in standalone mode; when the dashboard
  shell exposes a save target, the scanner posts the generated PDF back to it.

## Architecture

```
index.html
css/scanner.css
js/
  main.js          — main-thread entry (intake, worker dispatch, image ops,
                     crop, export)
  util.js          — pure helpers (blob-URL mgmt, canvasToBlob, sharpen kernel)
  decoders.js      — format detection + lazy PDF / HEIC / SVG decoders
  adjust.js        — brightness/contrast/saturation/sharpness sliders
  viewport.js      — linked Before/After viewports (zoom, pan, dblclick)
  cv-worker.js     — OpenCV worker (enhancement presets)
vendor/
  opencv/          — OpenCV.js 4.10
  pdfjs/           — pdf.js 4.0.379
  heic2any/        — heic2any 0.0.4
reference/
  scan2.py         — original Python reference implementation (not shipped)
```

All third-party libraries are vendored — no runtime CDN dependencies.

## Deploy

This repo is the **canonical source** for scanner JS (`js/main.js`,
`js/cv-worker.js`) and `vendor/`. The live dashboard at
`dashboard.msfgco.com/scanner.html` regenerates its copy via
`dashboard.msfgco.com/sync-scanner.sh`, which is called automatically from
`deploy.sh` before each S3 sync.

The sync applies four mechanical transforms when copying main-thread JS into
`dashboard/js/scanner-<name>.js`:

- Vendor paths: `'vendor/...'` → `'/vendor/...'` (absolute from dashboard root)
- Worker filename: `'js/cv-worker.js'` → `'js/scanner-worker.js'`
- Local ES imports: `from './<name>.js'` → `from './scanner-<name>.js'`
- Class selectors: `.zoom-toolbar` → `.sc-zoom-toolbar`, `.adj-value` → `.sc-adj-value`

Every main-thread module (main.js, util.js, decoders.js, adjust.js, viewport.js)
is transformed and written as `scanner-<name>.js`. `cv-worker.js` is copied
verbatim as `scanner-worker.js` (same transforms don't apply — it's a worker
with no DOM and no vendor imports).

**Do not edit the `dashboard/js/scanner-*.js` files directly** — edit this
repo's sources and re-run the sync (or just run the dashboard's `./deploy.sh`,
which runs it automatically).

CSS (`css/scanner.css`) and HTML shells (`index.html` vs `scanner.html`) are
**intentionally forked** and not synced:

- Dashboard `scanner.css` uses dashboard design tokens (`var(--green-teal)`,
  `var(--spacing-xl)`, etc.) and is scoped under `.sc-page` to coexist with
  dashboard's base.css. Standalone `scanner.css` owns the whole viewport.
- Dashboard `scanner.html` embeds in the dashboard shell (auth-gate, nav);
  standalone `index.html` is bare.

Changes that affect both styles/markup must still be applied to both files
manually — but those are rare compared to JS changes.

## Refactor status

- **Phase 1 (correctness)** — done: vendored CDNs, blob-URL leak fixes,
  escaped print filename, iframe `srcdoc` print, README.
- **Phase 2 (deduplicate)** — done: unified `canvasToBlob`,
  `downscaleBitmapToBudget`, and `buildSharpenKernel` so the export path
  can't drift from the live preview. Added zero-viewport guards in
  `fitView` / `getVisibleSourceRect`.
- **Phase 0 (kill the fork)** — done: `js/main.js` + `js/cv-worker.js` are
  now canonical here; dashboard regenerates via `sync-scanner.sh`.
- **Phase 3 (structural split)** — done: `main.js` (~1250 lines) split into
  `util.js`, `decoders.js`, `adjust.js`, `viewport.js`, and a leaner `main.js`
  (~800 lines) that owns the intake pipeline, image ops, crop, and export.
