# Changelog

## 0.1.0

First release: the page cleaner (`cleanPage`, Pass A in a WASM worker, Pass B
per-word normalization, rule and margin handling, word segmentation, ink
outlines) and the training-page import (`millirec-clean/train`). No runtime
dependencies.

- `cleanPage(imageData)` takes an `ImageData` whole, as well as `(rgba, width, height)`.
- Input is checked: pixels that are not `width × height × 4` RGBA bytes, a zero size, or a photo
  over `MAX_PIXELS` (64 MP) throw at once instead of returning an empty page.
- A worker that cannot load rejects with the URL it tried and how to fix it.
- Silent by default: the diagnostic log lines need `globalThis.__MILLIREC_CLEAN_DEBUG = true`.
