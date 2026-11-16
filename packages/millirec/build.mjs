// Assembles the npm package's dist/ from the same sources the downloadable
// templates come from:
//   library/src/char-lite.js, char-cnn.js, char-cnn-core.js  → esbuild, ESM + IIFE
//   library/templates/char-lite/{worker-stroke.js, millirec.wasm, sets/*}
//   library/templates/char-cnn/{*.bin, cnn-web*.{js,wasm}, options/*/config.js}
// The worker, the wasm and the model files are COPIED, not rebuilt: they need
// emcc (scripts/build-wasm-lite.sh) and the CNN trainers, and the templates are
// what has been measured. The runtimes are rebuilt here because the IIFE builds
// in the templates are byte-identical to an esbuild of the same source.
//
// dist/
//   char-lite/  index.js (ESM)  millirec-char-lite.min.js (script tag)
//               worker-stroke.js  millirec.wasm  sets/<name>.{json,js}  sets.json
//   char-cnn/   index.js  core.js (ESM)  millirec-char-cnn{,-core}.min.js
//               model files + kernels  options/<name>.{json,js}
//   overlap/    millirec-overlap.min.js (script tag)  millirec.wasm  training*.json  words.json
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
// esbuild: the millirec repo keeps it under server/; the public repository (github.com/triplelog/millirec) at its root
const ESBUILD = [path.join(ROOT, 'server/node_modules/.bin/esbuild'), path.join(ROOT, 'node_modules/.bin/esbuild')].find((f) => fs.existsSync(f)) || path.join(ROOT, 'node_modules/.bin/esbuild')
const TPL = path.join(ROOT, 'library/templates')
const DIST = path.join(HERE, 'dist')

if (!fs.existsSync(ESBUILD)) { console.error(`esbuild missing at ${ESBUILD} — run npm install at the repository root (in the full millirec repo: in server/)`); process.exit(1) }

// The script-tag builds open with "use strict". esbuild takes that from the nearest tsconfig.json
// (`strict`), which the full millirec repo has at its root and the public repository does not —
// so it is said here, and the output is the same bytes wherever this runs.
const STRICT = '--tsconfig-raw=' + JSON.stringify({ compilerOptions: { alwaysStrict: true } })
// ES modules ship readable (a bundler minifies them) and set no window globals; script-tag builds are minified
const esbuild = (entry, out, format, target) => execFileSync(ESBUILD, [
  entry, '--bundle', `--format=${format}`, ...(format === 'esm' ? ['--define:__MILLIREC_ESM__=true'] : ['--minify']),
  `--target=${target}`, `--outfile=${out}`, '--log-level=warning', STRICT,
], { stdio: 'inherit' })
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
// window.X = {...} (a template's training.js / config.js) → the object
const globalJson = (file, name) => {
  const src = fs.readFileSync(file, 'utf8')
  const m = src.match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*(?:window\\.|$)`))
  if (!m) throw new Error(`${file}: no window.${name} assignment`)
  return JSON.parse(m[1].trim().replace(/;$/, ''))
}

fs.rmSync(DIST, { recursive: true, force: true })

// ---- char-lite -------------------------------------------------------------
const LITE = path.join(DIST, 'char-lite')
fs.mkdirSync(path.join(LITE, 'sets'), { recursive: true })
esbuild(path.join(HERE, 'src/char-lite.js'), path.join(LITE, 'index.js'), 'esm', 'es2022')
esbuild(path.join(ROOT, 'library/src/char-lite.js'), path.join(LITE, 'millirec-char-lite.min.js'), 'iife', 'es2022')
for (const f of ['worker-stroke.js', 'millirec.wasm']) copy(path.join(TPL, 'char-lite', f), path.join(LITE, f))
copy(path.join(TPL, 'char-lite/sets/sets.json'), path.join(LITE, 'sets.json'))
const sets = fs.readdirSync(path.join(TPL, 'char-lite/sets'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
for (const s of sets) {
  const dir = path.join(TPL, 'char-lite/sets', s)
  const json = path.join(dir, 'training.json')
  const training = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : globalJson(path.join(dir, 'training.js'), 'MILLIREC_TRAINING')
  fs.writeFileSync(path.join(LITE, 'sets', s + '.json'), JSON.stringify(training))
  copy(path.join(dir, 'training.js'), path.join(LITE, 'sets', s + '.js'))
}
// the sets the ESM loader knows by name — kept in step with what shipped
const liteSrc = fs.readFileSync(path.join(HERE, 'src/char-lite.js'), 'utf8')
const named = liteSrc.match(/export const SETS = (\[[^\]]*\])/)
if (!named || JSON.stringify(JSON.parse(named[1].replace(/'/g, '"'))) !== JSON.stringify(sets)) {
  throw new Error(`src/char-lite.js SETS must list exactly the shipped sets: ${JSON.stringify(sets)}`)
}

// ---- char-cnn --------------------------------------------------------------
const CNN = path.join(DIST, 'char-cnn')
fs.mkdirSync(path.join(CNN, 'options'), { recursive: true })
esbuild(path.join(HERE, 'src/char-cnn.js'), path.join(CNN, 'index.js'), 'esm', 'es2020')
esbuild(path.join(HERE, 'src/char-cnn-core.js'), path.join(CNN, 'core.js'), 'esm', 'es2020')
esbuild(path.join(ROOT, 'library/src/char-cnn.js'), path.join(CNN, 'millirec-char-cnn.min.js'), 'iife', 'es2020')
esbuild(path.join(ROOT, 'library/src/char-cnn-core.js'), path.join(CNN, 'millirec-char-cnn-core.min.js'), 'iife', 'es2020')
const options = fs.readdirSync(path.join(TPL, 'char-cnn/options'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
for (const o of options) {
  const cfgFile = path.join(TPL, 'char-cnn/options', o, 'config.js')
  const cfg = globalJson(cfgFile, 'MILLIREC_CNN')
  // ship exactly the model and kernel files the options name (the templates hold the experiments too)
  for (const f of [cfg.kernel, cfg.kernel && cfg.kernel.replace(/\.js$/, '.wasm'), ...cfg.stages.flatMap((s) => [s.model, s.head])].filter(Boolean)) {
    if (!fs.existsSync(path.join(TPL, 'char-cnn', f))) throw new Error(`option ${o} needs ${f}, which is not in library/templates/char-cnn/`)
    copy(path.join(TPL, 'char-cnn', f), path.join(CNN, f))
  }
  fs.writeFileSync(path.join(CNN, 'options', o + '.json'), JSON.stringify(cfg, null, 2))
  copy(cfgFile, path.join(CNN, 'options', o + '.js'))
}

// ---- overlap (script tag only for now) ---------------------------------------
// Letters written one on top of another in one box. Bundled from source over the
// lite glue exactly as scripts/build-overlap.mjs does, so the bundle is the
// hosted embed byte for byte; with the base placeholder left in, it finds its
// wasm, training and words beside itself.
const OVERLAP = path.join(DIST, 'overlap')
const glue = path.join(ROOT, 'dist/lite/millirec.esm.js')
if (!fs.existsSync(glue)) throw new Error('dist/lite/millirec.esm.js missing — in the full millirec repo run scripts/build-wasm-lite.sh and scripts/build-overlap.mjs (the public repository ships it prebuilt)')
fs.mkdirSync(OVERLAP, { recursive: true })
execFileSync(ESBUILD, [
  path.join(ROOT, 'library/src/overlap.js'), '--bundle', '--format=iife', '--minify', '--target=es2020',
  '--alias:millirec-glue=' + glue, '--external:fs', '--external:path', '--log-override:commonjs-variable-in-esm=silent',
  '--outfile=' + path.join(OVERLAP, 'millirec-overlap.min.js'), '--log-level=warning', STRICT,
], { stdio: 'inherit' })
for (const f of fs.readdirSync(path.join(TPL, 'overlap'))) if (/^(training\.\w+|words)\.json$|\.wasm$/.test(f)) copy(path.join(TPL, 'overlap', f), path.join(OVERLAP, f))

// ---- types -------------------------------------------------------------------
copy(path.join(HERE, 'types/char-lite.d.ts'), path.join(LITE, 'index.d.ts'))
copy(path.join(HERE, 'types/char-cnn.d.ts'), path.join(CNN, 'index.d.ts'))
copy(path.join(HERE, 'types/char-cnn-core.d.ts'), path.join(CNN, 'core.d.ts'))
copy(path.join(HERE, 'types/overlap.d.ts'), path.join(OVERLAP, 'index.d.ts'))

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const files = walk(DIST)
const kb = files.reduce((n, f) => n + fs.statSync(f).size, 0) / 1024
console.log(`dist/: ${files.length} files, ${kb.toFixed(0)} KB — sets ${sets.join(', ')}; options ${options.join(', ')}`)
