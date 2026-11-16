# Changelog

## 0.1.2

- **char-cnn reads digits and lowercase letters**: two new options, `create('digits')` (99.6% of
  strangers' digits) and `create('lowercase')` (93.7%), the same pair of networks as `accurate`,
  trained on EMNIST plus this project's own writer.
- **`teach()`: symbols of your own with no training.** `rec.teach({ star: [d1, d2, d3], … })` keeps
  each drawing as what the network makes of it and reads new drawings by the nearest example;
  `forget()` undoes it, `create({ examples })` does it at creation. Three examples per class read
  96% of one writer's digits with the capitals-only network.
- **`fast` and `small` now run their own first network.** 0.1.0 and 0.1.1 shipped one `tiny.bin`
  for all three capital-letter options, so `fast` and `small` ran `accurate`'s first network instead
  of the ones they were measured with. Each option's model files now live in
  `dist/char-cnn/options/<name>/` (the option's JSON names them there; the shared wasm kernel stays
  beside the runtime). If you copied `dist/char-cnn/` into your site, copy it again.
- **char-lite and overlap: a new assignment solver, about a quarter faster.** The matcher's
  assignment step is now millirec's own (`cpp/assign.cpp` in the repository), written for this
  problem: it stops as soon as a template provably cannot matter, and it starts from prices that
  account for the points either side may drop. One recognition against 215 templates went from
  0.66 ms to 0.49 ms; the wasm is 27.8 KB (was 29.9). Readings can differ from 0.1.1 in close
  calls — on one writer's held-out drawings top-1 is unchanged for capitals and digits and two
  better of 381 for lowercase. Input the matcher cannot use (thousands of points, NaN
  coordinates) no longer traps.
- **A `recognize()` that timed out no longer poisons its strokes.** When char-lite's worker did
  not answer within 4 s the call resolved `null`, but the request stayed marked as in flight, so
  every later `recognize()` of the same strokes waited 4 s and resolved `null` again without the
  worker being asked. The request is forgotten once nobody is waiting on it (`rawScores()` too).
- A worker that fails after it has booted releases every waiting call with `null` at once; a
  worker that fails to boot is terminated and its blob URL revoked when `create()` rejects.
- README: a complete one-file page to start from (ES module from a CDN) and a complete script-tag
  page; which CDNs work (jsDelivr, unpkg — not esm.sh); pin the full version; how to load the
  overlap widget through a bundler; TypeScript notes; where to report bugs.
- package.json: `repository` (github.com/triplelog/millirec), `bugs` points at its issues.
- The source is public at github.com/triplelog/millirec, with the CNN trainer, one writer's
  handwriting and a walk-through for training a recognizer for your own symbols (not part of the
  npm download).

## 0.1.1

- **Bundlers**: the package found its own folder with `new URL('./', import.meta.url)`, which Vite
  and webpack 5 rewrite into a reference to the module FILE, so `loadSet()` fetched
  `…/index.js/sets/digits.json`. The folder is now sliced from `import.meta.url`. With a bundler,
  copy `dist/char-lite/` / `dist/char-cnn/` to your site and pass `assetBase` (README "Serving the
  files", with Vite and webpack recipes; the old `optimizeDeps` advice did not work in 0.1.0; with this fix `optimizeDeps: { exclude: ['millirec'] }` works in Vite dev only, and builds still need the copy).
- **Clear errors when the files are not served**: `loadSet`, `loadOption`, the CNN model/kernel
  loader and char-lite's worker/wasm boot now say which URL failed, what came back (a 404, an HTML
  page from an SPA fallback, unparseable JSON) and what to do, instead of failing in `JSON.parse` or
  the matcher.
- `"sideEffects"` lists the script-tag files (`dist/**/*.min.js`, `sets/*.js`, `options/*.js`) so a
  bundler keeps `import 'millirec/overlap/millirec-overlap.min.js'`.
- `destroy()`: char-lite resolves pending and later `recognize()`/`rawScores()` with `null`;
  char-cnn's `personalize()` returns `null`, `embedding()` throws `millirec: recognizer destroyed`,
  `depersonalize()` is a no-op (they used to read past an empty stage list).
- char-cnn runs in a Web Worker (draws on `OffscreenCanvas`); webpack no longer tries to bundle the
  kernel's dynamic import (`webpackIgnore`).
- Node / SSR: `create()` outside a browser throws a message saying so; `loadSet`/`loadOption` in
  Node say to import the JSON instead.
- `MillirecCharCnn.create('fast')` = `create({ option: 'fast' })`.
- char-lite's result cache is an LRU of 256 (it grew without bound).
- Types: `Training.version` is `number` (and `mode` a string) so an imported set JSON type-checks;
  `millirec:result` / `millirec:clear` are typed on `HTMLElementEventMap`; declarations for the
  overlap widget's global (`import type {} from 'millirec/overlap'`); `typesVersions` for
  `moduleResolution: node10`.
- package.json: `bugs`, `engines` (node ≥ 18, for tooling that imports the JSON).
- README: browser-only note, `destroy()`, the pad's options and events, overlap gzip sizes,
  stable paths.

## 0.1.0

First release.
