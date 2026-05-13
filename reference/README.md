# Reference implementations

Not shipped with the web app. Kept for posterity.

## `scan2.py`

The original Python CLI that inspired the browser port. Runs OpenCV locally
via `cv2` and writes `*_clean.png` + `*_bw.png` alongside the source image.

```bash
pip install opencv-python numpy
python3 scan2.py /path/to/image.jpg
```

The browser version in `js/cv-worker.js` reproduces (and extends) this
pipeline — `runAutoPreset` is the direct translation of `enhance_document`.
