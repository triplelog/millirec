// Tunable parameters, persisted in localStorage. Same UI conventions as
// better/src/params.js (stage-grouped sliders with descriptions).

import type { Params } from './pipeline';

export const STAGE_NAMES = [
  'Inputs & overlay',
  'Baseline attach',
  'Level baseline',
  'Rule removal',
  'Measure',
  'Height normalize',
  'Thickness normalize',
  'Smooth & render',
  'Composite page',
];

export interface ParamDef {
  key: string;
  label: string;
  stage: number; // stage index the param belongs to (1..)
  min: number;
  max: number;
  step: number;
  def: number;
  description: string;
}

export const PARAMS: ParamDef[] = [
  {
    key: 'inkThreshold', label: 'Ink threshold', stage: 1,
    min: 100, max: 250, step: 5, def: 200,
    description: 'Pixels darker than this (in the flattened image) count as ink when deciding which rule sits below the word.',
  },
  {
    key: 'padX', label: 'Horizontal padding', stage: 1,
    min: 0, max: 20, step: 1, def: 4,
    description: 'Extra columns added on each side of the segmenter box so clipped stroke ends are not lost.',
  },
  {
    key: 'padTop', label: 'Top padding', stage: 1,
    min: 0, max: 20, step: 1, def: 4,
    description: 'Extra rows added above the segmenter box (ascenders/diacritics clipped by tight boxes).',
  },
  {
    key: 'minInkAbove', label: 'Min ink above rule', stage: 1,
    min: 0.3, max: 0.95, step: 0.05, def: 0.55,
    description: 'A rule qualifies as the baseline only if at least this fraction of the word\'s ink lies above it. The topmost qualifying rule wins. Lower tolerates deep descenders; too low picks the rule above the word.',
  },
  {
    key: 'maxExtend', label: 'Max downward search', stage: 1,
    min: 0.2, max: 3, step: 0.1, def: 1.6,
    description: 'How far below the box bottom (in line heights) to search for a baseline rule when none is inside the box.',
  },
  {
    key: 'baselineMargin', label: 'Baseline margin', stage: 1,
    min: 0, max: 12, step: 1, def: 3,
    description: 'Rows kept below the rule band in the expanded crop, so descender strokes crossing the rule survive later rule removal.',
  },
  {
    key: 'fallbackPct', label: 'Fallback percentile', stage: 1,
    min: 60, max: 100, step: 1, def: 90,
    description: 'When no rule qualifies (e.g. last line of the page), the baseline is synthesized at this percentile of the word\'s ink y-coordinates.',
  },
  {
    key: 'levelMode', label: 'Unwarp (vs rotate)', stage: 2,
    min: 0, max: 1, step: 1, def: 0,
    description: 'Off = rigid rotation by the baseline\'s least-squares slope. On = per-column vertical shift that follows the actual rule trace — straightens curved baselines exactly, at the cost of slight vertical-only shear of the strokes.',
  },
  {
    key: 'rmMaxThick', label: 'Max rule thickness', stage: 3,
    min: 1, max: 20, step: 1, def: 8,
    description: 'Cap (px) on the rule thickness from the rules JSON. The removal band is the (capped) thickness centered on the leveled baseline.',
  },
  {
    key: 'rmBandPad', label: 'Band padding', stage: 3,
    min: 0, max: 6, step: 1, def: 1,
    description: 'Extra band rows on each side, absorbing leveling residue (rotation anti-aliasing, slight rule curvature in rotate mode).',
  },
  {
    key: 'rmDelta', label: 'Outlier darkness Δ', stage: 3,
    min: 5, max: 120, step: 5, def: 40,
    description: 'A band pixel must be at least this much DARKER than the band row\'s expected color (running median over the window below) to count as text. Lower protects more text; higher removes more aggressively.',
  },
  {
    key: 'rmWindow', label: 'Expected-color window', stage: 3,
    min: 10, max: 300, step: 10, def: 80,
    description: 'Half-width (px) of the sliding window along the band row for the expected (median) color. Clamped to the crop width for narrow words.',
  },
  {
    key: 'rmExtend', label: 'Run extension', stage: 3,
    min: 1, max: 10, step: 1, def: 2,
    description: 'Second text test: the pixel\'s vertical dark run (at the ink threshold) must extend at least this many px beyond the band — a crossing stroke continues, rule pixels don\'t. Both tests must pass.',
  },
  {
    key: 'rmGrow', label: 'Along-rule rescue', stage: 3,
    min: 0, max: 100, step: 5, def: 40,
    description: 'Strokes that curve and run ALONG the rule have no vertical continuation, so the run test alone erases them. Band pixels darker than the expected rule color are rescued when connected (8-way, up to this many px) to protected text or to ink just outside the band. 0 = off.',
  },
  {
    key: 'rmInpaint', label: 'Gap blending', stage: 3,
    min: 0, max: 20, step: 1, def: 4,
    description: 'Diffusion iterations that blend erased band pixels into their surroundings, bridging strokes that crossed the rule.',
  },
  {
    key: 'rmTint', label: 'Show classification', stage: 3,
    min: 0, max: 1, step: 1, def: 0,
    description: 'Tint the stage-3 contact sheet: removed pixels red, protected text green (same rendering as better\'s stage-6 preview). The detail panel always shows both views.',
  },
  {
    key: 'xhFrac', label: 'X-height threshold', stage: 4,
    min: 0.2, max: 0.8, step: 0.05, def: 0.3,
    description: 'The x-height band is the densest contiguous run of rows whose ink projection stays above this fraction of the peak. Lower stretches the band toward ascenders; higher shrinks it toward the densest core.',
  },
  {
    key: 'xhSmooth', label: 'Projection smoothing', stage: 4,
    min: 0, max: 4, step: 1, def: 2,
    description: 'Box-smoothing radius (rows) applied to the ink projection before finding the band. Bridges 1–2 row dips inside letters.',
  },
  {
    key: 'thickDark', label: 'Thickness ink cutoff', stage: 4,
    min: 100, max: 250, step: 5, def: 170,
    description: 'Stroke thickness = median of min(horizontal, vertical) dark-run through each pixel darker than this. Stricter than the general ink threshold so anti-aliased edges don\'t inflate the measurement.',
  },
  {
    key: 'scaleClamp', label: 'Max scale change', stage: 5,
    min: 0, max: 0.5, step: 0.01, def: 0.15,
    description: 'Each word is scaled so its x-height matches the page median, but the scale factor is clamped to 1 ± this. Limits the damage from any mis-measured word; 0 disables scaling entirely.',
  },
  {
    key: 'tnMaxChange', label: 'Max thickness change', stage: 6,
    min: 0, max: 6, step: 0.5, def: 2,
    description: 'Cap (px) on how much any stroke part may change toward the goal thickness. The surface moves by at most half this per side. 0 disables the offset (strokes are still re-rendered at uniform ink color).',
  },
  {
    key: 'tnTarget', label: 'Goal thickness', stage: 6,
    min: 0, max: 12, step: 0.5, def: 4,
    description: '0 = auto (page median). Otherwise strokes are pulled toward this thickness (px), still capped by Max thickness change. The offset adapts locally: parts thinner than the goal thicken, parts at or beyond it stay put — and vice versa when thinning.',
  },
  {
    key: 'dkPct', label: 'Max-black stroke %', stage: 6,
    min: 0, max: 95, step: 5, def: 10,
    description: 'Darkness normalization: this percentage of each word\'s stroke pixels is pushed to maximum black (the black point sits at that percentile of the stroke-darkness distribution). Darkening is anchored at the paper level, so only dark pixels darken — background pixels stay exactly as they were (fully transparent in the composite). 0 = off.',
  },
  {
    key: 'tnSurface', label: 'Stroke surface', stage: 6,
    min: 0.25, max: 0.75, step: 0.05, def: 0.4,
    description: 'Ink-coverage level treated as the stroke boundary (0.5 = halfway between paper and ink). Lower pushes the boundary out into fainter gray — strokes read and render thicker; higher pulls it into the dark core.',
  },
  {
    key: 'tnInk', label: 'Ink level override', stage: 6,
    min: 0, max: 150, step: 5, def: 0,
    description: 'Gray value treated as full ink when computing coverage. 0 = auto per word (median of each word\'s darkest pixels). Set manually if faint words mis-estimate their own ink color.',
  },
  {
    key: 'tnEdge', label: 'Edge softness', stage: 6,
    min: 0.6, max: 4, step: 0.1, def: 2,
    description: 'Anti-aliased falloff width (px) OUTSIDE the stroke surface. Inside, coverage saturates to full ink within a fixed small depth, so stroke centerlines always hit max darkness regardless of this setting.',
  },
  {
    key: 'smRadius', label: 'SDF smoothing radius', stage: 7,
    min: 0, max: 5, step: 1, def: 1,
    description: 'Blur radius (px) applied to the signed distance field before re-rendering. Rounds stroke wobble and jaggies; all darkness levels smooth together so contours can\'t cross. Too high rounds real corners and can pinch thin gaps.',
  },
  {
    key: 'smTurd', label: 'Potrace speckle', stage: 7,
    min: 0, max: 10, step: 1, def: 2,
    description: 'Potrace turdsize: ink blobs smaller than this many px are dropped before vectorizing.',
  },
  {
    key: 'smAlphaMax', label: 'Potrace corner threshold', stage: 7,
    min: 0, max: 1.3, step: 0.05, def: 1,
    description: 'Potrace alphamax: how aggressively corners are smoothed into curves. 0 = keep all corners sharp (polygon-like); 1.3 = everything becomes smooth curves.',
  },
  {
    key: 'cpSource', label: 'Composite source', stage: 8,
    min: 0, max: 2, step: 1, def: 0,
    description: 'Which finished version to place on the page: 0 = SDF-smoothed strokes, 1 = potrace vectors (falls back to SDF until tracing finishes), 2 = thickness-normalized without smoothing.',
  },
  {
    key: 'cpRules', label: 'Draw rules', stage: 8,
    min: 0, max: 1, step: 1, def: 1,
    description: 'Draw the straightened rules (light gray, at each rule\'s median y) on the output page. Words sit with their baseline exactly on these lines.',
  },
  // Appended (not inserted mid-array) so existing positional param arrays keep
  // their indices. Stage 3 → grouped under Rule removal in the lab UI.
  {
    key: 'rmGapBridge', label: 'Rescue gap bridge', stage: 3,
    min: 1, max: 8, step: 1, def: 3,
    description: 'Connectivity radius (px) for the along-rule rescue. A band pixel is kept as text when a kept/text pixel lies within this many px in ANY direction, so small light gaps in a stroke sitting on the rule don\'t break the connection. 1 = strict 8-neighbour (old behaviour).',
  },
  {
    key: 'rmRescueDelta', label: 'Rescue darkness Δ', stage: 3,
    min: 5, max: 120, step: 5, def: 30,
    description: 'A band pixel qualifies for the connectivity rescue when it is at least this much darker than the expected rule colour (gentler than Outlier darkness Δ, which only seeds obvious crossing strokes). Lower keeps more faint text lying on the rule; too low starts keeping the rule itself.',
  },
  {
    key: 'rmShapePrune', label: 'Shape prune', stage: 3,
    min: 0, max: 20, step: 1, def: 3,
    description: 'After classification, erase any connected ink shape touching a rule band that never reaches more than this many px past the rule — a rule remnant. Baseline/bottom rules require the shape to extend ABOVE (letters sit above the baseline); the line-above rule and the vertical margin accept extension on either side. 0 = off. Higher removes more aggressively (can clip low marks).',
  },
  {
    key: 'inkSlack', label: 'Ink hysteresis Δ', stage: 1,
    min: 0, max: 80, step: 5, def: 25,
    description: 'Second, gentler ink threshold for stroke detection. A pixel that is not quite dark enough for the ink threshold still counts as ink when it connects (flood fill) to a pixel that is — so anti-aliased stroke edges and faint stroke parts join the same stroke. 0 = single hard threshold (old behaviour).',
  },
];

export function defaultParams(): Float32Array {
  return Float32Array.from(PARAMS.map((p) => p.def));
}

/**
 * Decode a flat param array into the keyed `Params` object the pipeline stages
 * consume. Defaults are used when `values` is omitted. The lab UIs build this
 * from their slider state (`currentParams()`); non-UI callers (the editor
 * import) use the defaults.
 */
export function paramObject(values?: Float32Array): Params {
  const vals = values ?? defaultParams();
  const o: Record<string, number> = {};
  PARAMS.forEach((p, i) => (o[p.key] = vals[i]));
  return o as unknown as Params;
}
