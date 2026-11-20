// Node smoke test: run the full Pass A pipeline on a synthetic ruled page
// and sanity-check every stage.
//
// Usage (needs a TS-aware loader for params.ts):
//   npx tsx clean/wasm/test/smoke.mjs
import assert from 'node:assert/strict';
import createModule from '../../assets/hw.mjs';
import { makeSample } from './synthetic.mjs';
import { PARAMS, STAGE_NAMES, defaultParams } from '../../passA/params.ts';

const mod = await createModule();
const img = makeSample({});

const ptr = mod._hw_set_input(img.width, img.height);
assert.notEqual(ptr, 0, 'hw_set_input returned NULL');
mod.HEAPU8.set(img.data, ptr);
mod.HEAPF32.set(defaultParams(), mod._hw_params() >> 2);

const timings = [];
for (let s = 1; s <= 8; s++) {
  const t0 = performance.now();
  const rc = mod._hw_run_stage(s);
  timings.push(`${STAGE_NAMES[s]}: ${(performance.now() - t0).toFixed(1)}ms`);
  assert.equal(rc, 0, `stage ${s} (${STAGE_NAMES[s]}) failed with rc=${rc}`);
}

function preview(stage) {
  const p = mod._hw_preview(stage);
  assert.notEqual(p, 0, `no preview for stage ${stage}`);
  const w = mod._hw_preview_w();
  const h = mod._hw_preview_h();
  return { w, h, data: mod.HEAPU8.slice(p, p + w * h * 4) };
}

// page detection found the paper
assert.equal(mod._hw_quad_found(), 1, 'page quad not detected');

// a plausible number of rules was traced (synthetic page has ~20)
const nRules = mod._hw_rule_count();
const nVrules = mod._hw_vrule_count();
assert.ok(nRules >= 10 && nRules <= 26, `rule count ${nRules} outside [10,26]`);
assert.ok(nVrules >= 1, 'margin line not detected');

// auto line-height estimate is near the synthetic 46px rule spacing
const lineHeight = mod._hw_line_height();
assert.ok(
  lineHeight > 32 && lineHeight < 58,
  `line height ${lineHeight.toFixed(1)} outside [32,58] (true spacing 46)`
);

// a best pair was found, both members survived acceptance, energies are strong
const bestA = mod._hw_best_pair_a();
const bestB = mod._hw_best_pair_b();
const bestEa = mod._hw_best_pair_ea();
const bestEb = mod._hw_best_pair_eb();
assert.ok(bestA >= 0 && bestB >= 0, `best pair members not accepted (a=${bestA}, b=${bestB})`);
assert.notEqual(bestA, bestB, 'best pair collapsed onto one rule');
assert.ok(bestEa > 6 && bestEb > 6, `best pair energy too weak: ${bestEa}, ${bestEb}`);

// measured rule thickness is sane (synthetic rules are 2px + AA skirt)
const midRule = Math.floor(nRules / 2);
const thick = mod._hw_rule_thick(midRule);
assert.ok(thick >= 2 && thick <= 7, `rule thickness ${thick} outside [2,7]`);

// line removal: along the mid rule the flat image is mostly dark, the
// binarized output mostly paper (only text crossings may remain as ink)
const flat = preview(4);
const bin = preview(7);
{
  let darkFlat = 0;
  let inkAfter = 0;
  let n = 0;
  for (let x = 10; x < flat.w - 10; x += 2) {
    const y = mod._hw_rule_y_at(midRule, x);
    if (y < 0) continue;
    if (flat.data[(y * flat.w + x) * 4] < 200) darkFlat++;
    if (bin.data[(y * bin.w + x) * 4] === 0) inkAfter++;
    n++;
  }
  assert.ok(darkFlat / n > 0.5, `rule unexpectedly faint in flat (${darkFlat}/${n})`);
  assert.ok(inkAfter / n < 0.3, `rule not removed: ${inkAfter}/${n} ink px remain`);
}

// stage-6 classification tint: many removed (red) px, some protected (green)
const nolines = preview(6);
{
  let removed = 0;
  let protectedPx = 0;
  for (let i = 0; i < nolines.w * nolines.h; i++) {
    const r = nolines.data[i * 4];
    const g = nolines.data[i * 4 + 1];
    if (r > g + 20) removed++;
    else if (g > r + 20) protectedPx++;
  }
  assert.ok(removed > 2000, `too few removed-tinted px: ${removed}`);
  assert.ok(protectedPx > 20, `no protected-text-tinted px: ${protectedPx}`);
}

// traced rules are near-parallel: consecutive gaps at mid-page should be
// close to the synthetic 46px spacing (multiples allowed for skipped blanks)
{
  const midX = Math.floor(flat.w / 2);
  const ys = [];
  for (let r = 0; r < nRules; r++) ys.push(mod._hw_rule_y_at(r, midX));
  ys.sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) {
    const gap = ys[i] - ys[i - 1];
    const mod46 = gap % 46 > 23 ? 46 - (gap % 46) : gap % 46;
    assert.ok(mod46 <= 6, `gap ${gap} between rules ${i - 1},${i} not ~multiple of 46`);
  }
}

// despeckle with min area 0 AND border margin 0 must be a strict no-op
{
  const p = defaultParams();
  const iMin = PARAMS.findIndex((x) => x.key === 'speckleMin');
  const iMargin = PARAMS.findIndex((x) => x.key === 'borderMargin');
  p[iMin] = 0;
  p[iMargin] = 0;
  mod.HEAPF32.set(p, mod._hw_params() >> 2);
  assert.equal(mod._hw_run_stage(8), 0);
  const bin = preview(7);
  const noop = preview(8);
  assert.deepEqual(noop.data, bin.data, 'despeckle modified image despite being disabled');
  // restore defaults and re-run stage 8 for the assertions below
  mod.HEAPF32.set(defaultParams(), mod._hw_params() >> 2);
  assert.equal(mod._hw_run_stage(8), 0);
}

// binarized output has a sane ink fraction
const clean = preview(8);
let ink = 0;
for (let i = 0; i < clean.w * clean.h; i++) if (clean.data[i * 4] === 0) ink++;
const frac = ink / (clean.w * clean.h);
assert.ok(frac > 0.002 && frac < 0.25, `ink fraction ${frac.toFixed(4)} outside (0.002, 0.25)`);

// rule/margin intersections are removed outright: at every rule crossing of
// the margin line, the binarized output must be paper
{
  const binI = preview(7);
  let inkAtCross = 0;
  for (let r = 0; r < nRules; r++) {
    const vx = mod._hw_vrule_x_at(0, Math.floor(binI.h / 2));
    const yc = mod._hw_rule_y_at(r, vx);
    if (vx < 0 || yc < 0) continue;
    if (binI.data[(yc * binI.w + vx) * 4] === 0) inkAtCross++;
  }
  assert.ok(inkAtCross <= 1, `${inkAtCross} rule/margin intersections still have ink`);
}

// ---- vertical seam scenarios ----
function runVariant(opts) {
  const v = makeSample(opts);
  const p = mod._hw_set_input(v.width, v.height);
  mod.HEAPU8.set(v.data, p);
  mod.HEAPF32.set(defaultParams(), mod._hw_params() >> 2);
  for (let s = 1; s <= 5; s++) {
    assert.equal(mod._hw_run_stage(s), 0, `variant stage ${s} failed`);
  }
  return { vrules: mod._hw_vrule_count(), vthick: mod._hw_vrule_thick(0) };
}

// single margin line: found, single-line thickness
{
  const r = runVariant({});
  assert.equal(r.vrules, 1, 'single margin not found');
  assert.ok(r.vthick >= 4 && r.vthick <= 9, `single-margin thickness ${r.vthick} outside [4,9]`);
  console.log(`  vertical: single margin thick=${r.vthick}px`);
}

// double margin (2px + 4px gap + 2px = 8px extent): found as ONE thick seam
{
  const r = runVariant({ doubleMargin: true });
  assert.equal(r.vrules, 1, 'double margin not found');
  assert.ok(r.vthick >= 10 && r.vthick <= 16, `double-margin thickness ${r.vthick} outside [10,16]`);
  console.log(`  vertical: double margin thick=${r.vthick}px`);
}

// WIDE double margin: the two rules sit further apart than one rule is thick.
// The probe used to look only max_t+2 past the first run, so anything beyond a
// ~10px gap measured a single line and left the second one in the page.
for (const gap of [10, 16, 20]) {
  const r = runVariant({ doubleMargin: true, marginGap: gap });
  const extent = 4 + gap; // two 2px rules plus the light gap between them
  assert.equal(r.vrules, 1, `double margin (gap ${gap}) not found`);
  assert.ok(
    r.vthick >= extent,
    `double margin (gap ${gap}) measured ${r.vthick}px, needs >= ${extent}px to cover both rules`
  );
  console.log(`  vertical: double margin gap=${gap} thick=${r.vthick}px (extent ${extent})`);
}

// no margin, only a page-edge shadow strip: must be edge-rejected
{
  const r = runVariant({ margin: false, edgeShadow: true });
  assert.equal(r.vrules, 0, `edge shadow not rejected (vrules=${r.vrules})`);
  console.log('  vertical: edge shadow rejected, no margin found');
}

console.log('smoke test PASSED');
console.log(`  page quad: found, rules: ${nRules}, vrules: ${nVrules}`);
console.log(`  best pair: rules ${bestA}+${bestB}, energy ${bestEa.toFixed(1)} + ${bestEb.toFixed(1)}`);
console.log(`  line height (auto): ${lineHeight.toFixed(1)}px (true spacing 46)`);
console.log(`  mid-rule thickness: ${thick}px`);
console.log(`  ink fraction: ${(frac * 100).toFixed(2)}%`);
console.log('  ' + timings.join('\n  '));
