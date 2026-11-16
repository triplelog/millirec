# millirec

Small, fast handwriting recognition in the browser. Draw a character, get the
three likeliest readings back. Runs entirely on the device — no server, no
upload of anyone's ink.

**[millirec.com](https://millirec.com)** has a pad to try it on and the measurements ·
source and issues: **[github.com/triplelog/millirec](https://github.com/triplelog/millirec)**

## Try it: one file, no build

Save this as `index.html`, serve the folder (`npx serve`, `python3 -m http.server` — a page opened
straight from disk cannot start the worker) and draw a digit:

```html
<!doctype html>
<meta charset="utf-8">
<div id="pad" style="width: 240px; height: 240px; border: 1px solid #999"></div>
<p id="out">draw a digit</p>
<script type="module">
  import { MillirecCharLite, loadSet } from 'https://cdn.jsdelivr.net/npm/millirec@0.1.2/dist/char-lite/index.js'

  const rec = await MillirecCharLite.create({ training: await loadSet('digits') })
  rec.attach(document.querySelector('#pad'))
  document.querySelector('#pad').addEventListener('millirec:result', (e) => {
    const r = e.detail.results || []          // best first; empty when the pad was cleared
    document.querySelector('#out').textContent = r.length
      ? r.map((x) => `${x.char} ${Math.round(x.prob * 100)}%`).join('   ')
      : 'draw a digit'
  })
</script>
```

Write another digit after a two-second pause and the pad starts over; scribble over the ink to
clear it.

## What is in it

Three pieces, pick by what you need to read:

| | reads | size (gzip) | trainable on your own strokes |
|---|---|---|---|
| `millirec/char-lite` | anything you have samples for: digits, letters, punctuation, emoji, made-up symbols | 26 KB + the training set (digits 4 KB, all 27 KB) | **yes** — add samples, add whole new classes |
| `millirec/char-cnn` | capital letters A–Z | 15 KB (`small`) to 47 KB (`fast`); `accurate` 42 KB | refit on a writer's own letters (`personalize`) |
| overlap (script tag) | whole words written letter over letter in one box | 34 KB (script 20 + wasm 14) + training (capitals 19 KB, all 42 KB) + the default word list (38 KB, skipped when you pass `words`) | — |

## Install

```sh
npm install millirec
```

`import … from 'millirec'` is the same as `'millirec/char-lite'`. The package is ES modules only
(use `import`, not `require`), or the script-tag builds below.

**Browser only.** Recognition needs a browser: char-lite runs its matcher in a Web Worker, char-cnn
draws strokes on a canvas (an `OffscreenCanvas` inside a worker works too). Importing the package
is safe during server-side rendering; call `create()` on the client. In Node, `create()` throws a
message saying so, and the training sets can be imported as JSON
(`import digits from 'millirec/char-lite/sets/digits.json' with { type: 'json' }`) for tooling.

**TypeScript**: declarations are included. Importing a set or option as JSON needs
`resolveJsonModule` (and `esModuleInterop` under `moduleResolution: node10`).

## char-lite

```js
import { MillirecCharLite, loadSet } from 'millirec/char-lite'

const training = await loadSet('digits')        // 'all' | 'capitals' | 'digits' | 'lowercase' | 'punctuation'
const rec = await MillirecCharLite.create({ training })

// a drawing pad that reports after every stroke
const pad = rec.attach(document.querySelector('#pad'))
document.querySelector('#pad').addEventListener('millirec:result', (e) => {
  console.log(e.detail.results)                  // [{ char: '7', prob: 0.91 }, ...]
})

// or your own strokes: arrays of {x, y} points
await rec.recognize([[{ x: 50, y: 10 }, /* ... */ { x: 52, y: 120 }]])

rec.destroy()                                     // when you are done with it
```

Each char-lite instance holds a Web Worker and its own copy of the wasm matcher, so call
`destroy()` when a recognizer is no longer needed (and share one recognizer between several pads
rather than creating one per pad). After `destroy()`, `recognize()` and `rawScores()` resolve
`null`, including calls that were still waiting.

### The drawing pad

`attach(el, options)` mounts a canvas in `el` and returns a `Pad` (`clear()`, `undoClear()`,
`getStrokes()`, `isStale()`, `configure()`, `setInk()`, `repaint()`, `canvas`). Options:

| option | default | |
|---|---|---|
| `width`, `height` | 240, 240 | pad size in CSS px |
| `ink` | `'#1e293b'` | ink colour |
| `idleOverwrite` | 2 | seconds of pen-up after which the next stroke starts a new character (0 = off) |
| `scribbleClear` | true | scribbling over the character throws it away |
| `scribble` | null | overrides for the scribble detector's bars (`turns`, `retrace`, `winding`, `cover`) |
| `staleAlpha` | 0.3 | opacity of ink once the character has settled (1 keeps it solid) |
| `onStale` | — | `(stale) => void`, called on every change of the settled state |

`el` fires two events:

- `millirec:result` — after every stroke, `detail = { results, strokes }` (`results` is the top
  three `{ char, prob }`; an empty pad reports `results: []`, so a reading of ink that is gone can be
  cleared);
- `millirec:clear` — the pad dropped its own ink, `detail = { reason: 'idle' | 'scribble', undo }`;
  `undo()` puts it back.

Both are typed on `HTMLElementEventMap`, so `el.addEventListener('millirec:result', (e) => e.detail.results)`
type-checks. char-cnn's `attach()` takes the same options and fires the same events.

### Training on your users' strokes

A class name is any string, so a recognizer can learn one person's hand, or
symbols nobody else uses:

```js
const mine = MillirecCharLite.withSamples(training, {
  '7': [strokesOfASeven, anotherSeven],          // appended to the shipped 7s
  '★': [star1, star2, star3],                    // a brand-new class
})
const rec = await MillirecCharLite.create({ training: mine })
```

Drawings are resampled to the set's points-per-shape, so pass raw strokes.
`{ replace: true }` drops a class's shipped samples instead of appending —
worth it once you have three or four of the writer's own. Keep the raw strokes
(in localStorage, IndexedDB, your server — the library never stores anything)
and rebuild the training object when the recognizer starts. The format is
plain JSON (`version: 2`, see `Training` in the type declarations), so a
training set can also be built offline and loaded with `fetch`.

## char-cnn

```js
import { MillirecCharCnn } from 'millirec/char-cnn'

const rec = await MillirecCharCnn.create()                    // the 'accurate' option
// or: await MillirecCharCnn.create({ option: 'fast' })        // 'accurate' | 'fast' | 'small'
// (a bare name works too: create('fast'))
rec.attach(document.querySelector('#pad'))
await rec.recognize(strokes, { only: 'AEIOU' })              // restrict the answer to some letters
await rec.personalize({ A: [a1, a2, a3], R: [r1, r2] })      // lean toward this writer's hand
rec.destroy()                                                // let go of the models
```

`millirec/char-cnn/core` is the same recognizer without the drawing pad; it also runs inside a
Web Worker (it draws on an `OffscreenCanvas` there). After `destroy()`, `recognize()` and
`personalize()` return `null` and `embedding()` throws.

### Your own symbols

`create()` takes any model in the same format: `MillirecCharCnn.create({ classes, stages, assetBase })`,
where `classes` is a string of single characters or a list of names. Training one from your own
drawings — a dozen per symbol, a few seconds — is a four-command walk-through in the repository:
[train your own recognizer](https://github.com/triplelog/millirec/blob/main/packages/millirec/train/README.md).

## overlap: words written in one box

Letters written one on top of another in a single box, read against a word list. Script tag only
for now:

```html
<script src="/millirec/overlap/millirec-overlap.min.js"></script>
<div id="box"></div>
<script>
  MillirecOverlap.create(document.getElementById('box'), { set: 'capitals', words: ['HELLO', 'WORLD'] })
</script>
```

Copy `dist/overlap/` to your site (or load it from a CDN); the script finds its wasm, training and
default word list beside itself. `set` is `capitals`, `lowercase`, `digits`, `punctuation` or `all`.
TypeScript declarations for the `MillirecOverlap` global and its `millirec-overlap:*` events come
with `import type {} from 'millirec/overlap'`. That path is **types only**: the widget itself is
the script tag, and a plain `import 'millirec/overlap'` fails with "path not exported". To pull the
script through a bundler instead, import the file —
`import 'millirec/overlap/millirec-overlap.min.js'` — and pass `assetBase` to `create()`, since a
bundled script can no longer find the files beside it.

## Serving the files

The recognizers load a worker, a wasm file, training sets and model files at run time, by default
from the folder the module itself is in. That works as-is when the browser loads the package's
files where they are — no bundler, an import map, or a dev server that serves `node_modules`.

**With a bundler** (Vite, webpack, Rollup, esbuild, Parcel …) the JavaScript is moved into your
bundle and the other files are not emitted with it. Copy the recognizer's folder into the folder
your site serves as-is, and pass its URL as `assetBase` to every call that loads something:

```js
import { MillirecCharLite, loadSet } from 'millirec'
import { MillirecCharCnn } from 'millirec/char-cnn'

const lite = '/millirec/char-lite/'               // copied from node_modules/millirec/dist/char-lite/
const training = await loadSet('digits', { assetBase: lite })
const rec = await MillirecCharLite.create({ training, assetBase: lite })

const cnn = await MillirecCharCnn.create({ option: 'fast', assetBase: '/millirec/char-cnn/' })   // dist/char-cnn/
// loadOption(name, { assetBase }) takes it too
```

Vite — copy into `public/`, which is served (and copied into the build) unchanged:

```sh
mkdir -p public/millirec
cp -R node_modules/millirec/dist/char-lite node_modules/millirec/dist/char-cnn public/millirec/
```

(a `postinstall` script with those two lines keeps it in step with the installed version).
In `vite` dev alone, `optimizeDeps: { exclude: ['millirec'] }` also works without copying (the dev
server then serves the package from `node_modules`), but `vite build` does not emit the files, so a
production build still needs the copy and `assetBase`.

webpack 5 — with `copy-webpack-plugin`:

```js
// webpack.config.js
import CopyPlugin from 'copy-webpack-plugin'
export default {
  plugins: [new CopyPlugin({ patterns: [
    { from: 'node_modules/millirec/dist/char-lite', to: 'millirec/char-lite' },
    { from: 'node_modules/millirec/dist/char-cnn', to: 'millirec/char-cnn' },
  ] })],
}
```

`assetBase` may be absolute, root-relative or relative to the page, with or without the trailing
slash. If the files are not there, the error names the URL it tried and what came back (a dev
server's index.html fallback is recognised as such) instead of failing inside the matcher.

**`assetBase` (and char-cnn's `kernel`) decide which code is loaded** — the worker and kernel are
fetched from there and run. Set them in your own code; never fill them from a URL parameter, a
query string or anything a visitor can type.

### Content-Security-Policy

If your site sends a CSP, the recognizers need:

- `worker-src blob:` — char-lite boots its worker from a blob that loads `worker-stroke.js`;
- `script-src 'wasm-unsafe-eval' 'unsafe-eval'` — the matcher is WebAssembly, and its generated
  bindings (char-lite's worker, overlap) use `new Function`;
- `connect-src` for wherever the files are served from, if that is another origin.

## Script tag / CDN

No build step and no modules — a complete page:

```html
<!doctype html>
<meta charset="utf-8">
<div id="pad" style="width: 240px; height: 240px; border: 1px solid #999"></div>
<p id="out">draw a digit</p>
<script src="https://cdn.jsdelivr.net/npm/millirec@0.1.2/dist/char-lite/millirec-char-lite.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/millirec@0.1.2/dist/char-lite/sets/digits.js"></script>
<script>
  MillirecCharLite.create().then((rec) => {
    rec.attach(document.querySelector('#pad'))
    document.querySelector('#pad').addEventListener('millirec:result', (e) => {
      var r = e.detail.results || []
      document.querySelector('#out').textContent = r.length ? r.map((x) => x.char).join(' ') : 'draw a digit'
    })
  })
</script>
```

`sets/<name>.js` sets `window.MILLIREC_TRAINING`; for char-cnn load
`dist/char-cnn/options/accurate.js` and then `millirec-char-cnn.min.js`. The
script finds its worker and wasm next to itself, on any origin that sends CORS
headers.

**Which CDNs work** (tried in a browser from another origin): **jsDelivr** and **unpkg**, for the
script tags and for the ES modules (`…/dist/char-lite/index.js`, and jsDelivr's `/+esm`). **esm.sh
does not**: it serves a rewritten copy of the JavaScript without the worker and wasm files beside
it, so `create()` reports that they are not served.

**Pin the full version** (`@0.1.2`, not `@0.1`). The script, its worker and its wasm are separate
files that must come from the same release, and a CDN resolves a version range file by file.

## Stable paths

The documented entry points are the stable API: `millirec`, `millirec/char-lite`,
`millirec/char-cnn`, `millirec/char-cnn/core`, `millirec/char-lite/sets/<name>.json`,
`millirec/char-cnn/options/<name>.json`, `millirec/overlap/<file>` and the script-tag files in "Script tag / CDN"
above. `millirec/dist/*` exposes every built file as an escape hatch; the layout under it may change
in any release.

## Where the data comes from

- **char-lite training sets and the overlap templates**: one writer's own handwriting, drawn for
  this project.
- **char-cnn models**: small CNNs trained on handwritten capitals from EMNIST (derived from NIST
  Special Database 19).
- **overlap's default word list** (`words.json`): the 10,000 commonest English words by millirec's
  own count over about 1.9 billion words of English, mostly news — names and offensive words
  removed. It leans toward news vocabulary; pass your own `words` for anything specific.

Recognition runs entirely in the browser: nothing a user draws is sent anywhere by this package.

## Versions

0.x: the API may still change between minor versions. 1.0 will mark it stable. Changes are in
[CHANGELOG.md](https://github.com/triplelog/millirec/blob/main/packages/millirec/CHANGELOG.md).

## Questions and bugs

[Open an issue](https://github.com/triplelog/millirec/issues). A drawing that reads wrong is most
useful with its strokes (`pad.getStrokes()`, or `e.detail.strokes` from the result event) and the
set or option in use.

## License

MIT

---

## This repository

The source of the [`millirec`](https://www.npmjs.com/package/millirec) npm package. The package
itself is [`packages/millirec`](packages/millirec); the folders beside it are what it is built from.

| | |
|---|---|
| `packages/millirec/` | the package: `build.mjs`, the ES-module entry points (`src/`), the type declarations (`types/`), the tests |
| `packages/millirec/train/` | **[train your own recognizer](packages/millirec/train/README.md)**: drawings → a model the package loads, with one writer's handwriting to start from |
| `cnnlab/` | the CNN trainer (`caps.py`, PyTorch) and what it imports |
| `library/src/` | the recognizers: `char-lite.js`, `char-cnn.js`, `char-cnn-core.js`, `overlap.js` |
| `core/` | the training format, the stroke math, and the overlap engine (`core/overlap/overlap.js`) |
| `widget/` | the drawing pad (`canvas.js`) and the scribble-to-clear gesture (`scribble.js`) |
| `server/public/wordgpu/` | the CNN's forward pass in plain JavaScript |
| `library/templates/`, `dist/lite/` | **prebuilt files** the build copies: the matcher (WebAssembly) and its worker, the CNN kernel and model files, the training sets, the overlap templates and word list |

```sh
npm install        # esbuild
npm run build      # writes packages/millirec/dist/, the files the npm package ships
npm test           # builds, then reads drawn strokes in headless Chrome (needs Google Chrome)
```

The JavaScript is built from source here, and the CNN trainer is here to make models of your own.
Included as built, without their sources: the WebAssembly point-cloud matcher (char-lite, overlap),
the CNN's WebAssembly kernel, and the shipped capital-letter models (trained on EMNIST).

The folder layout mirrors the larger private repository this is exported from, which is why a few
paths look deeper than they need to be. Work happens there and is exported here release by
release, so a pull request is best opened as an issue first.
