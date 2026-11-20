// Verification gate for millirec-clean:
// 1. Verifies dist/ artifacts (bundles, worker, assets, typescript types)
// 2. Dynamic import of the built ESM entries (index.mjs, train.mjs)
// 3. Runs the WASM Pass A smoke test pipeline
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..')
const DIST = path.join(PKG, 'dist')
const ROOT = path.join(PKG, '..', '..')

console.log('Verifying millirec-clean dist/ artifacts...')

// 1. Verify build files
const requiredFiles = [
  'index.mjs',
  'train.mjs',
  'worker.mjs',
  'assets/hw.mjs',
  'assets/hw.wasm',
  'types/index.d.ts',
  'types/trainImport.d.ts',
]

for (const f of requiredFiles) {
  const p = path.join(DIST, f)
  assert.ok(fs.existsSync(p), `Missing built artifact: dist/${f}`)
  const size = fs.statSync(p).size
  assert.ok(size > 0, `Artifact is empty: dist/${f}`)
}

const wasmSize = fs.statSync(path.join(DIST, 'assets/hw.wasm')).size
assert.ok(wasmSize > 30_000, `hw.wasm unexpectedly small: ${wasmSize} bytes`)
console.log(`  ✓ dist artifacts present (hw.wasm: ${(wasmSize / 1024).toFixed(0)} KB)`)

// 2. Dynamic import of built ESM entries
const indexMod = await import(path.join(DIST, 'index.mjs'))
assert.equal(typeof indexMod.cleanPage, 'function', 'cleanPage export missing in index.mjs')
assert.equal(typeof indexMod.PassASession, 'function', 'PassASession export missing in index.mjs')
assert.ok(Array.isArray(indexMod.PAGE_TEMPLATES), 'PAGE_TEMPLATES array missing in index.mjs')
assert.equal(typeof indexMod.setWasmAssetBase, 'function', 'setWasmAssetBase export missing')
assert.equal(typeof indexMod.setWorkerUrl, 'function', 'setWorkerUrl export missing')

const trainMod = await import(path.join(DIST, 'train.mjs'))
assert.equal(typeof trainMod.importTrainingPage, 'function', 'importTrainingPage export missing in train.mjs')
assert.equal(typeof trainMod.runTrainingPassA, 'function', 'runTrainingPassA export missing in train.mjs')
console.log('  ✓ built ESM entries imported successfully')

// 3. Smoke test the WASM module
const smokeScript = path.join(ROOT, 'clean/wasm/test/smoke.mjs')
if (fs.existsSync(smokeScript)) {
  console.log('Running WASM smoke test...')
  execFileSync('npx', ['tsx', smokeScript], { cwd: ROOT, stdio: 'inherit' })
  console.log('  ✓ WASM smoke test passed')
}

console.log('All millirec-clean checks passed.')
