// Builds the millirec-clean npm package from ../../clean (the page cleaner's
// TypeScript source — the same files the millirec labs and server use).
//
//   npm run build        (also runs on `npm pack` / `npm publish`)
//
// dist/
//   index.mjs   — the `millirec-clean` entry (clean/index.ts)
//   train.mjs   — `millirec-clean/train` (clean/trainImport.ts)
//   chunk-*.mjs — code the two share. ONE copy, so module state (the WASM asset
//                 base, the worker URL override) is the same whichever entry
//                 set it.
//   worker.mjs  — the Pass A worker the driver starts
//   assets/     — hw.mjs + hw.wasm, the page cleaner. Serve them, and point
//                 the worker at them with setWasmAssetBase() if they are not
//                 at /wasm/.
//   types/      — .d.ts for both entries, generated from the source
//
// No runtime dependencies: everything the cleaner needs is bundled.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const SRC = path.join(ROOT, 'clean')
const DIST = path.join(HERE, 'dist')
const ESBUILD = [path.join(ROOT, 'server/node_modules/.bin/esbuild'), path.join(ROOT, 'node_modules/.bin/esbuild')].find((f) => fs.existsSync(f))
const TSC = path.join(HERE, 'node_modules/.bin/tsc')
if (!ESBUILD) { console.error('esbuild missing — npm install in millirec/server first'); process.exit(1) }
if (!fs.existsSync(TSC)) { console.error('typescript missing — npm install in packages/millirec-clean first'); process.exit(1) }

fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true })

execFileSync(ESBUILD, [
  'index=' + path.join(SRC, 'index.ts'),
  'train=' + path.join(SRC, 'trainImport.ts'),
  '--bundle', '--format=esm', '--target=es2022', '--splitting',
  '--out-extension:.js=.mjs', '--chunk-names=chunk-[hash]',
  '--log-override:empty-import-meta=silent',
  '--outdir=' + DIST,
], { stdio: 'inherit' })
execFileSync(ESBUILD, [
  path.join(SRC, 'passA/worker.ts'),
  '--bundle', '--format=esm', '--target=es2022',
  '--outfile=' + path.join(DIST, 'worker.mjs'),
], { stdio: 'inherit' })
for (const f of ['hw.mjs', 'hw.wasm']) fs.copyFileSync(path.join(SRC, 'assets', f), path.join(DIST, 'assets', f))

// REPOINT THE WORKER URL AT THE BUILT WORKER. The driver starts its worker
// with `new Worker(new URL('./passA/worker.ts', import.meta.url))` — right for
// the source, a 404 in the build. Every bundler that understands that pattern
// (Vite, webpack 5, Turbopack, esbuild) sees `./worker.mjs` beside the chunk
// and ships it. Exactly one literal, asserted, so a reworded driver fails the
// build instead of shipping a worker that cannot start.
{
  let hits = 0
  for (const f of fs.readdirSync(DIST).filter((n) => n.endsWith('.mjs'))) {
    const p = path.join(DIST, f)
    const src = fs.readFileSync(p, 'utf8')
    const n = src.split('"./passA/worker.ts"').length - 1 + src.split("'./passA/worker.ts'").length - 1
    if (n) {
      hits += n
      fs.writeFileSync(p, src.replaceAll('"./passA/worker.ts"', '"./worker.mjs"').replaceAll("'./passA/worker.ts'", "'./worker.mjs'"))
    }
  }
  if (hits !== 1) throw new Error(`expected exactly one './passA/worker.ts' to repoint, found ${hits} — has passADriver.ts changed how it starts the worker?`)
}

// Types, generated from the source.
const tsconfig = path.join(HERE, 'tsconfig.types.json')
fs.writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable', 'WebWorker.ImportScripts'],
    declaration: true, emitDeclarationOnly: true, skipLibCheck: true, strict: false, resolveJsonModule: true,
    allowImportingTsExtensions: true, noEmitOnError: false,
    rootDir: SRC, outDir: path.join(DIST, 'types'),
  },
  files: [path.join(SRC, 'index.ts'), path.join(SRC, 'trainImport.ts'), path.join(SRC, 'node-env.d.ts')],
}, null, 2))
try { execFileSync(TSC, ['-p', tsconfig], { stdio: 'inherit' }) } catch { /* errors printed; the check below decides */ }
fs.rmSync(tsconfig)
for (const f of ['index.d.ts', 'trainImport.d.ts']) {
  if (!fs.existsSync(path.join(DIST, 'types', f))) throw new Error(`type generation produced no ${f}`)
}

// NodeNext/Node16 resolution (a "type": "module" package) requires explicit
// extensions on relative imports in .d.ts files; tsc copies the source's
// extensionless specifiers. Rewrite each to the file that exists.
const TYPES = path.join(DIST, 'types')
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
for (const f of walk(TYPES).filter((n) => n.endsWith('.d.ts'))) {
  const dir = path.dirname(f)
  const fixed = fs.readFileSync(f, 'utf8').replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(['"])/g, (m, a, spec, z) => {
    if (/\.(js|mjs|json)$/.test(spec)) return m
    if (fs.existsSync(path.join(dir, spec + '.d.ts'))) return a + spec + '.js' + z
    if (fs.existsSync(path.join(dir, spec, 'index.d.ts'))) return a + spec + '/index.js' + z
    throw new Error(`${path.relative(DIST, f)}: cannot resolve ${spec}`)
  })
  fs.writeFileSync(f, fixed)
}

// Nothing private ships. The same rule as scripts/export-public.mjs: doc-comment
// lines in the generated types that name private projects or paths are
// dropped (the source keeps them); anything left anywhere in dist fails the build.
const DENY = /jatijm|digitizer|gifsaw|sudokufarm|rnbqkbnr|\/Users\/|robmwilc|@gmail|CLAUDE\.md|\bRob\b(?! ?ert Wilcox)|ANTHROPIC|password|secret/i
for (const f of walk(TYPES).filter((n) => n.endsWith('.d.ts'))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  // A doc-comment line (starts with `*`, not `*/`) that names something
  // private is dropped — unless it also CLOSES the comment, in which case the
  // closing `*/` stays, or the declaration after it would be swallowed.
  const out = []
  for (const l of lines) {
    if (!(DENY.test(l) && /^\s*\*(?!\/)/.test(l))) { out.push(l); continue }
    if (l.includes('*/')) out.push(l.replace(/^(\s*)\*.*$/, '$1*/'))
  }
  fs.writeFileSync(f, out.join('\n'))
}
const leaks = []
for (const f of [...walk(DIST), path.join(HERE, 'README.md'), path.join(HERE, 'CHANGELOG.md'), path.join(HERE, 'package.json')]) {
  if (/\.wasm$/.test(f) || !fs.existsSync(f)) continue
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (l.length < 4000 && DENY.test(l)) leaks.push(`${path.relative(HERE, f)}:${i + 1}: ${l.trim().slice(0, 120)}`) })
}
if (leaks.length) throw new Error(`private names in what would ship:\n${leaks.join('\n')}`)

const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`
const files = fs.readdirSync(DIST).filter((n) => n.endsWith('.mjs'))
console.error('millirec-clean dist: ' + files.map((f) => `${f} ${kb(path.join(DIST, f))}`).join(' · ') + ` · hw.wasm ${kb(path.join(DIST, 'assets/hw.wasm'))}`)
