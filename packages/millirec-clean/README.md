# millirec-clean

Cleans up photographed handwriting in the browser. It finds the page and
flattens it, removes ruled lines and shadows, binarizes, segments the words,
and normalizes each word's height and stroke thickness. The heavy pass (Pass A)
is a small WASM module that runs in a Web Worker; the passes around it are
plain TypeScript.

It is the page cleaner behind [millirec](https://millirec.com). It runs in the
browser only: Pass A needs `Worker`.

```sh
npm install millirec-clean
```

## Use

```js
import { cleanPage } from 'millirec-clean'

// The photo's pixels, e.g. from a file input:
const bitmap = await createImageBitmap(file)
const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
const ctx = canvas.getContext('2d')
ctx.drawImage(bitmap, 0, 0)
const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height)

const page = await cleanPage(image)   // or cleanPage(image.data, image.width, image.height)

for (const word of page.recs) {
  if (word.status === 'empty' || !word.smooth) continue   // nothing usable there
  // word.line, word.index — reading order
  // word.box              — { x, y, w, h } on the FLATTENED page (page.pass.pageW × pageH), not the photo
  // word.smooth           — the cleaned crop (ImageData)
}
```

`cleanPage(image, options?)` or `cleanPage(rgba, width, height, options?)` resolves to:

| field | what it is |
|---|---|
| `recs` | one record per word in reading order: `line`, `index`, `box`, `status` (`'ok'`, `'extended'`, `'fallback'` or `'empty'`), and the cleaned crop in `smooth` |
| `targetXh` | the page's median x-height after normalization, in px; scale text to it to match the writing's size |
| `segPage` | the whole cleaned page (`pass.pageW × pass.pageH`, one byte per pixel) for a recognizer that reads whole lines |
| `pass` | the Pass A output: the flattened page, rule traces and page corners |
| `marginMarks` | formatting symbols found in the margin strip, keyed to `recs[i].line` |
| `dewarp` | what the rule-guided flattening did, and why when it did not |

Every field is typed; see `CleanPageResult` in the bundled `.d.ts`.

**Input.** RGBA bytes, `width × height × 4` of them; anything else is a `TypeError` or
`RangeError` at once. Photos are limited to 64 MP (`MAX_PIXELS`, above every phone camera): the
cleaner works at about 1500 px on the long edge, but the whole photo is copied to its worker first,
so downscale a bigger one before calling. A page takes about a second (`cleanPage` on an
830×1106 page: 0.7–0.8 s in Chrome on a laptop, the first call included).

**Privacy.** Everything runs on the device: no network requests except loading the package's own
worker and WASM, no telemetry.

**Debugging.** The cleaner is silent. `globalThis.__MILLIREC_CLEAN_DEBUG = true` (or
`localStorage['hw-pipeline-v2-debug'] = '1'`) turns on its diagnostic log lines.

`millirec-clean/train` has the training-page import: the same cleanup with its
intermediate stages exposed, for building a writer's own glyph bank.

## Where the WASM goes

The worker loads `hw.mjs`, which loads `hw.wasm` from the same folder. Both are
in `node_modules/millirec-clean/dist/assets/`. Serve them **together, under
those names** (not hashed), from `/wasm/`, or say where they are **before the
first `cleanPage`**:

```js
import { setWasmAssetBase } from 'millirec-clean'
setWasmAssetBase('/static/millirec-clean/')   // resolved against the site's origin
```

The worker `import()`s `hw.mjs` from that base, so it runs as code: point it
only at your own origin (or a CDN you trust), never at a value from user input.

If they are missing, a single-page-app fallback that answers every path with
your `index.html` shows up as a module-load error from the worker rather than a
404. That error means the asset path is wrong.

## The worker

`dist/worker.mjs` is started with
`new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' })`.
Vite, webpack 5 and Turbopack find and ship it on their own, and so does loading
the package unbundled (from `node_modules` or a CDN).

**esbuild, Rollup without a worker plugin, or anything else** leaves that line
alone and ships no worker. Copy `dist/worker.mjs` beside your assets and say
where it is before the first `cleanPage`:

```js
import { setWorkerUrl } from 'millirec-clean'
setWorkerUrl('/static/millirec-clean/worker.mjs')
```

A worker that cannot load rejects `cleanPage` at once with the URL it tried.

**Vite dev server:** older Vite versions' dependency pre-bundling moves the
package into `node_modules/.vite/deps/` without its worker (Vite 8 does not).
If the worker fails to load in `vite dev`, exclude the package:

```js
// vite.config.js
export default { optimizeDeps: { exclude: ['millirec-clean'] } }
```

`vite build` needs nothing.

## What is stable

`cleanPage`, its options and result, `setWasmAssetBase`, `setWorkerUrl`,
`MAX_PIXELS` and `millirec-clean/train`'s `importTrainingPage` are the API.
The other exports are the passes `cleanPage` is built from — Pass A sessions,
rule and margin helpers, outlines, page templates — for callers composing their
own flow; they are typed and tested through `cleanPage`, but may change between
0.x releases.

## TypeScript

Types ship in the package and work with `moduleResolution` set to `Bundler`,
`NodeNext` or `Node16`.

No runtime dependencies. MIT licensed.
