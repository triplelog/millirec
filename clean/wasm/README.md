# Pass A — C source

Whole-page handwriting cleanup. All pixel work runs in a custom C library
compiled to WASM (60 KB as of Sep 4 2026); the browser handles decode and orchestration in a
Web Worker (`clean/passA/worker.ts`).

No third-party libraries — not even OpenCV. Every algorithm below is
implemented from scratch in `src/`, and the tree builds anywhere `emcc` is
available.

> **Provenance.** Salvaged from the retired `handywrite` sandbox project, where
> this lived beside a Vite tuning UI. That UI was not brought over; the stage
> descriptions below still describe exactly what the C does. The compiled
> artifact this source produces is byte-identical to the `hw.wasm` already
> shipped in `public/wasm/`.

## Pipeline (Pass A — global cleanup)

| # | Stage | What it does |
|---|-------|--------------|
| 1 | Grayscale + downscale | Area-averaged working image (long edge = *Working resolution*) |
| 2 | Page detection | Otsu bright-mask → largest component → corner extremes → validated quad (green overlay = detected, orange = full-frame fallback) |
| 3 | Perspective correction | 8×8 homography solve, bilinear inverse warp |
| 4 | Illumination flatten | Background estimated at 1/N scale via grayscale close, then **divided** out — normalizes paper color, shadows, lighting falloff |
| 5 | Rule tracing | **Auto line height**: hundreds of stratified probes in the page center measure the dark-to-dark vertical gap; the 95th percentile is the line height, and pair spacing bounds derive from it (0.5×/1.5×). Then **coupled parallel seam pairs** on a block-summed energy map: candidate starts seed from the left edge, both seams of a pair trace via one joint DP whose gap may drift at most *Pair skew tolerance* px from its left-edge value, and each seam is locally slope-limited to *Local slope limit* px per 20 horizontal px (block stepping — no purely global wander band). Lowest-cost pairs win; shared members dedup. Horizontal rules are ONLY accepted as pair members (no solo fallback). Vertical lines (max one, possibly a close double): slope-limited single-seam block DP on the transposed energy, **edge-rejected** (a real line has paper-bright pixels on both flanks in ≥80% of sampled rows; a page edge/shadow doesn't — candidates failing this are skipped), thickness probed with a lookahead past the light gap to capture double margin lines as one band, then re-traced on a **uniform box-averaged** thick energy (not center-weighted — a double line's energy sits at the band edges). Runs TWICE: pass 1 detects, then rule thickness is probed along the traces (90th percentile of uncrossed columns) and pass 2 re-traces on a center-weighted thick energy so seams lock onto rule centerlines. (red = rules, green = best pair, blue = vertical; line height + best-pair cost in the status bar) |
| 6 | Line removal | Removal band = each rule's measured thickness centered on its trace. Every band pixel is classified by TWO tests and kept as text only if it passes BOTH: (1) darker than the rule's expected color — a running per-band-row MEDIAN over a ±*Expected-color window* along the seam, one-sided (darker only); (2) its vertical dark run extends ≥ *Run extension* px beyond the band. Everything else is erased and blended to background (vertical interpolation + diffusion). Vertical lines use a laxer fixed ink threshold (225) and +2px band padding. Where a horizontal band crosses a vertical band, pixels are removed unconditionally (two printed lines meeting, not a stroke). The preview tints removed pixels red and protected text green. |
| 7 | Binarize | Sauvola adaptive threshold via integral images |
| 8 | Despeckle | Union-find connected components; tiny blobs removed, plus components lying *entirely* within the border-margin ring (page-edge shadows). Components extending into the interior are never removed, so text chained to a leftover line is safe. |

Next passes (planned): Tesseract.js word boxes on the Pass A output, then
per-word full-res cleanup (crop+rotate by local rule angle, band-constrained
line removal, per-word binarize/smooth).

## Build and test

```sh
source ~/Desktop/projects/emsdk/emsdk_env.sh   # emcc must be on PATH
npm run build:wasm    # → public/wasm/hw.mjs + hw.wasm
npm test              # Node smoke test on a synthetic ruled page
```

`build.sh` writes straight into `public/wasm/`, which the app serves from
`/wasm/`, so a rebuild is immediately what the app runs. There is no copy step.

The smoke test runs all 8 stages against a deterministic synthetic page and
asserts the page quad was found, ~20 rules traced, the auto line-height lands
near the true 46 px spacing, rules are actually removed, despeckle is a strict
no-op when disabled, and the margin-line cases behave (single, double, and a
page-edge shadow that must be *rejected*).

## The parameter index contract

**`src/hw.h`'s `P_*` enum and `../src/handwriting/passA/params.ts` are one
array in two languages.** The JS side writes a flat `Float32Array` into the
WASM heap at `hw_params()`, so entry *n* in `params.ts` is read as `P_<n>` in C
purely by position. Adding, removing, or reordering a parameter in one file
without doing the same in the other silently feeds every later stage the wrong
number — nothing errors, the output just gets subtly worse.

Both files carry a comment saying so. Keep them together; they were in separate
repositories before, which is how the contract became easy to break.

## Layout

- `src/core/` — image struct, chunked arena allocator, morphology
  (sliding min/max deque, O(n)), blur, Otsu, drawing helpers
- `src/global/` — one file per pipeline stage, in stage order
- `src/hw.h` — parameter enum + context struct (see the contract above)
- `src/api.c` — exported C ABI + per-stage RGBA preview rendering
- `test/smoke.mjs` — the Node smoke test
- `test/synthetic.mjs` — deterministic synthetic "photo" fixture (ruled cream
  paper, margin line, squiggle text with descenders, lighting gradient, 3°
  rotation, dark desk background)

The JS half lives in `../src/handwriting/passA/`: `params.ts` (the registry,
with labels/ranges/descriptions) and `worker.ts` (owns the WASM instance and
streams per-stage previews back as transferables).

## Notes

- The WASM module (`public/wasm/hw.mjs` + `hw.wasm`) is a build artifact;
  rebuild with `npm run build:wasm` after touching C code.
- Pixels never cross the JS/WASM boundary per-stage: the image is written
  into the WASM heap once, stages pass pointers, only previews are copied out.
- Page detection's corner-extremes step assumes the page is roughly upright
  (rotation ≪ 45°).
