// millirec/clean — turn a photo of handwriting on paper into clean, normalized
// per-word images.
//
//   photo → Pass A (WASM global cleanup)  → flat page + rule traces
//         → margin detection + word segmentation
//         → Pass B (per-word baseline / rule removal / height + thickness / smooth)
//         → WordRec[]
//
// This half of millirec does no recognition. It produces clean ink; deciding
// what the ink SAYS is the recognizer's job, and is deliberately separate — the
// cleaning is useful on its own to anyone who just wants a readable scan.
//
// Nothing here imports a framework or touches the DOM outside a Web Worker and
// canvas-free typed-array math, so it runs in a page, in a worker, or (for the
// Pass B half) in Node.
//
// Pass A runs in a Web Worker. Instantiate it with:
//   new Worker(new URL('./passA/worker', import.meta.url), { type: 'module' })
// and serve assets/hw.{mjs,wasm} from your app — /wasm/ by default, or call
// setWasmAssetBase() to point elsewhere.
//
// The submodules carry colliding names (WordBox, PARAMS, STAGE_NAMES,
// defaultParams), so they are re-exported under namespaces. Import specific
// helpers directly from the submodule when you need them by bare name.

/** File-format contracts that cross pass boundaries (rules JSON, boxes JSON),
 *  plus the margin-mark contract Pass B's caller consumes. */
export type {
  RulesJson, RuleTrace, VRuleTrace, BoxesJson, WordBox,
  MarginKind, MarginMark,
} from './types';

/** Word segmentation — projection boxes + geometry-only split/merge. Superseded
 *  for import by ccWordBoxes below; kept for its geometry helpers. */
export * as segment from './segment';

/** Triplet-window OCR alignment: map a line-level reading back onto word boxes. */
export * as ocr from './ocr/align';

// Imported rather than `export * as` because cleanPage() below uses them too,
// and a module cannot both re-export a namespace and bind it locally.
import * as passA from './passA/params';
import * as passB from './passB/pipeline';
import * as passBParams from './passB/params';

/** `passA` — WASM global page cleanup: param metadata + defaults (the worker is
 *  a URL entry, not a function). `passB` — the per-word normalization stages.
 *  `passBParams` — Pass B param metadata and defaults, for tuning UIs. */
export { passA, passB, passBParams };

// ---- drivers and stages, for callers that need to compose their own flow ----

export { runPassA, detectPageQuad, openPassA, PassASession, mergeStages, setWasmAssetBase, setWorkerUrl, QUAD_REJECT, MAX_PIXELS, checkImage } from './passADriver';
export type { PassAResult, PassAStages, PassARunOptions, PageQuad, QuadReject } from './passADriver';
/** Which way up a page is, from its own ink — see clean/orientation.ts. */
export { detectOrientation, rotateRgba, grayOf } from './orientation';
export type { Orientation } from './orientation';
export { improveRules, completeRuleGrid, detectGridRules, pruneTextCrossingRules, ccWordBoxes, liftFaintDots, restoreDots, refineInk, growInkSet, eraseRuleResidue, eraseWeldedRuleResidue, eraseVRuleResidue, findFlatStripResidue } from './ccWordSeg';
export type { DotCandidate } from './ccWordSeg';
export type { CCWordOut, FaintDot } from './ccWordSeg';
/** Hand-editing which pixels are text: the paint mask, the brush, and the
 *  three-valued "what is included right now" map both paint UIs draw. */
export {
  PAINT_NONE, PAINT_ADD, PAINT_CUT, PAINT_DARKISH,
  INCL_NONE, INCL_LOOSE, INCL_WORD,
  makeInkPaint, inkPaintEmpty, inkPaintKey, stampBrush, applyInkPaint, inclusionMap,
} from './inkPaint';
export type { InkPaint } from './inkPaint';
export { detectMarginLine, classifyMarginGlyphs } from './margin';
/** What KIND of paper this is — ruled, plain, grid, dot grid — as a selectable
 *  template plus a classifier that reads it off the page. */
export {
  PAGE_TEMPLATES, AUTO_MIN_CONFIDENCE, DOUBLE_MARGIN_FRAC, templateById,
  templateParams, classifyTemplate, detectVLattice, detectDotLattice,
  removeDotLattice, inkBaselines,
} from './pageTemplate';
export type {
  PageTemplate, PageTemplateId, TemplateChoice, TemplateEvidence,
  VLattice, DotLattice,
} from './pageTemplate';
/** Handwriting as outlines: trace a cleaned word, store it compactly, render it
 *  as an SVG mask that scales and bolds without re-rendering. */
export {
  traceInk, simplify, encodeOutline, decodeOutline,
  outlineToPath, outlineToSvg, outlineToDataUri, vectorizeCoverage,
  pathOutline, traceGray, renderSmoothInk,
} from './vector';
export type {
  WordOutline, TraceOptions, SvgOptions, PathSink, FillSink, SmoothInkOptions,
} from './vector';

export { sdfThickenCrop, sdfThicknessAdapt, matteNormalize, matteNormalizeAlpha } from './sdfBold';
export type { MatteNormalizeOpts } from './sdfBold';
export { splitInkCrop, mergeInkCrops, shiftInkBoundary } from './mergeSplit';
export { componentOwnership, ownershipMask, releaseUncoveredMarks, extendCropsToOwnedInk } from './ccOwnership';
export type { OwnershipPrior } from './ccOwnership';
export { quadCandidates } from './pageQuad';
export type { QuadCandidate } from './pageQuad';
export { removeEdgeShadows } from './shadows';
export type { EdgeShadowResult } from './shadows';
export type { ComponentOwnership } from './ccOwnership';
export type { InkCrop } from './mergeSplit';

/** Margin-symbol recognition: trace a glyph's contour and match it against the
 *  trained exemplars in data/symbolset.json. Used by the pipeline for photo
 *  imports, and directly by editors that let a writer draw the same symbols. */
export {
  classifyGlyphContours, traceContours, smoothLoop, maskFeatures, maskToFeature,
  getMarginTemplates, renderTemplateSetPreview, MARGIN_SYMBOLS,
} from './marginRecognition';
export type {
  MarginSymbol, Pt, ContourPoint, MarginTemplate, GlyphClassification,
} from './marginRecognition';

import { openPassA, mergeStages, checkImage, type PassAResult, type PassASession } from './passADriver';
import { detectMarginLine, classifyMarginGlyphs } from './margin';
import { refineRuleTrace, improveRules, completeRuleGrid, detectGridRules, pruneTextCrossingRules, ccWordBoxes, liftFaintDots, eraseRuleResidue, eraseWeldedRuleResidue, eraseVRuleResidue, findFlatStripResidue } from './ccWordSeg';
import type { CCWordOut, DotCandidate, FlatStripCandidate } from './ccWordSeg';
import { removeHRulesPage } from './trainImport';
import { dewarpByRules, type DewarpResult } from './dewarpRules';
import { pairTraceRules } from './pairTrace';
import { removeEdgeShadows, type EdgeShadowResult } from './shadows';
import { quadCandidates, type QuadCandidate } from './pageQuad';
import { dumpV2Debug } from './debug';
import { componentOwnership, ownershipMask, releaseUncoveredMarks, extendCropsToOwnedInk } from './ccOwnership';
import type { OwnershipOverride, ComponentOwnership } from './ccOwnership';
import { applyInkPaint, inkPaintEmpty, type InkPaint } from './inkPaint';
import type { MarginMark } from './types';
import { debugLog } from './log';
import {
  AUTO_MIN_CONFIDENCE, classifyTemplate, detectDotLattice, detectVLattice,
  inkBaselines, removeDotLattice, templateById, templateParams,
  type PageTemplate, type PageTemplateId, type TemplateChoice,
} from './pageTemplate';

const PAGE_ENABLE_IDX = passA.PARAMS.findIndex((p) => p.key === 'pageEnable');
const PAGE_MANUAL_IDX = passA.PARAMS.findIndex((p) => p.key === 'pageManual');
const WORK_MAXDIM_IDX = passA.PARAMS.findIndex((p) => p.key === 'workMaxDim');
const WORK_MAXDIM_MAX = passA.PARAMS[WORK_MAXDIM_IDX]?.max ?? 3000;
/** Ruled-line spacing (working px) the rest of the pipeline is tuned for. The
 *  three pages that read well land at 74-80; the two that failed were at 52.
 *  Expressed as line height rather than x-height because Pass A measures it
 *  before any of the x-height machinery exists. */
const TARGET_LINE_H = 78;

/**
 * How far the ruled lines' slope SWINGS from the top of the page to the bottom.
 *
 * On lined paper the rules are parallel by construction, so after a correct
 * dewarp every band of the page agrees on one slope and this is ~0. A keystone
 * — whether it was in the photo or introduced by warping to a wrong page quad —
 * makes the rules converge, and the slope then varies monotonically down the
 * page. That makes this a direct, cheap measurement of whether a dewarp helped
 * or hurt, which is worth far more than trusting the quad detector: on two of
 * five test pages the detector "found" a quad that was really the image border
 * and warped a perfectly square photo into a 13-degree keystone.
 *
 * Implementation is one sheared row-profile per candidate slope, accumulated
 * into y-bands: a rule is a nearly-full-width dark run, so at the right slope a
 * band's profile has sharp peaks and high variance. ~11M samples, tens of ms.
 */
function ruleSlopeSwing(gray: Uint8Array, W: number, H: number): { swing: number; slopes: number[] } {
  const NB = 5;
  const step = Math.max(1, Math.floor(W / 150));
  const nS = Math.floor(W / step);
  // paper level from a sparse sample, so a dark photo does not read as all ink
  const samp: number[] = [];
  for (let i = 0; i < W * H; i += 997) samp.push(gray[i]);
  samp.sort((a, b) => a - b);
  const paper = samp[Math.floor(samp.length * 0.85)] || 200;
  const darkT = Math.max(0, paper - 26);
  const best = new Array(NB).fill(0).map(() => ({ v: -1, s: 0 }));
  const bandOf = (y: number) => Math.min(NB - 1, Math.floor((y * NB) / H));
  // The sheared scan is 61 slopes x H rows x W/step columns — ~15M samples on a
  // 1125x1500 page. Two hoists, both EXACT: the darkness test becomes one
  // page-wide pass instead of 61, and each sampled column's offset from the
  // shear centre is computed once. `Math.round(y + …)` is deliberately NOT
  // rewritten as `y + Math.round(…)` — see the same note in pageQuad.ts, where
  // that rewrite moved a page.
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) dark[i] = gray[i] < darkT ? 1 : 0;
  const xs: number[] = [];
  for (let x = 0; x < W; x += step) xs.push(x);
  const kx = new Float64Array(xs.length);
  for (let k = 0; k < xs.length; k++) kx[k] = xs[k] - W / 2;
  for (let s = -0.30; s <= 0.3001; s += 0.01) {
    // per-band running sum/sumsq of the sheared row darkness
    const n = new Float64Array(NB), sum = new Float64Array(NB), sq = new Float64Array(NB);
    for (let y = 0; y < H; y++) {
      let d = 0, c = 0;
      for (let k = 0; k < xs.length; k++) {
        const yy = Math.round(y + s * kx[k]);
        if (yy < 0 || yy >= H) continue;
        c++;
        d += dark[yy * W + xs[k]];
      }
      if (c < nS * 0.7) continue;      // row leaves the image at this slope
      const f = d / c, b = bandOf(y);
      n[b]++; sum[b] += f; sq[b] += f * f;
    }
    for (let b = 0; b < NB; b++) {
      if (n[b] < 8) continue;
      const v = sq[b] / n[b] - (sum[b] / n[b]) ** 2;   // variance of the profile
      if (v > best[b].v) { best[b].v = v; best[b].s = s; }
    }
  }
  const slopes = best.filter((b) => b.v > 0).map((b) => +b.s.toFixed(3));
  if (slopes.length < 3) return { swing: 0, slopes };
  return { swing: Math.max(...slopes) - Math.min(...slopes), slopes };
}

export interface CleanPageOptions {
  /** Skip page detection/dewarp entirely — use the full frame as-is. */
  skipDewarp?: boolean;
  /** TL,TR,BR,BL (gray coords) to use instead of auto-detection. Ignored when
   *  skipDewarp is set. */
  manualQuad?: number[];
  /** Long edge of the working image, px (Pass A `workMaxDim`, default 1500). */
  workMaxDim?: number;
  /** OPT-IN: re-run once with a widened quad when letter-sized ink runs into
   *  the warped page's left/right boundary (the quad cut through writing).
   *  Recovers frame-cut letters but admits the off-page shadow band —
   *  measured 10->28 errors on weirdpage as a default; see the retry block. */
  edgeInkRetry?: boolean;
  /**
   * Re-run Pass A at a higher working resolution when the ruled lines come out
   * closer together than the pipeline expects. **Default false, and that is a
   * measurement, not a guess.**
   *
   * The case for it looked overwhelming: across the five labelled pages, median
   * x-height 32-38 px read at 15-19% word error while 20-24 px read at 96%, and
   * raising the resolution moved a page from 23 word boxes to 89. All of that
   * turned out to be a symptom of a DIFFERENT bug — `inkMask` dropped the
   * pixels sitting exactly on its Otsu threshold, which wiped out whole word
   * crops on the synthetic-darkness segmentation page, and small crops hit that
   * degenerate case far more often. With the off-by-one fixed, small writing
   * reads fine: page E is 5.4% word error at the default resolution and 7.5% at
   * the raised one, and the raised pass costs an extra second of Pass A.
   *
   * Kept because the knob is genuinely useful on a low-resolution SOURCE photo,
   * where there really are too few pixels — but off by default, so nobody
   * rediscovers the correlation and re-enables it.
   */
  autoWorkDim?: boolean;
  /**
   * Check the auto-detected page quad by measuring whether it made the ruled
   * lines flatter, and fall back to the full frame when it did not (default
   * true). The quad detector reports success on the image border, so on a
   * close-up photo of lined paper it can invent a keystone that nothing
   * downstream survives.
   */
  autoDewarpCheck?: boolean;
  /** Lift dark edge shadows/background strips to paper after Pass A (default
   *  true). See clean/shadows.ts for what separates a shadow from writing. */
  edgeShadows?: boolean;
  /** Which detector's quad DRIVES the page crop/warp. 'fused' (default): the
   *  per-side fusion of the TS candidates (clean/pageQuad.ts — measured 0.21%
   *  mean corner error against hand labels vs the WASM detector's 4.70%);
   *  its snapped flags decide warp vs crop vs full frame. 'wasm': the WASM
   *  detector with the overflow-crop arbitration. */
  quadPick?: 'fused' | 'wasm';
  /** How an auto-detected page quad may be APPLIED. 'auto' (default): a quad
   *  whose corners are real is perspective-warped as always, but an OVERFLOW
   *  quad (the sheet runs past the picture — its "corners" are the bright
   *  region's outline) only CROPS to its axis-aligned bounds, leaving the
   *  geometry to the rule-guided dewarp. 'warp' restores the old
   *  warp-regardless behaviour. */
  quadUse?: 'auto' | 'warp';
  /** Emit per-rule dewarp snapshots (`dewarpSteps` on the result) — the rule
   *  set ordered most-confident-first, each prefix's warp applied to a scratch
   *  copy at half resolution. Debug/lab only; default off. */
  dewarpSteps?: boolean;
  /** Overrides for the pair tracer — read by the faint-rules rescue when
   *  `rescueTracer` is 'pair', and by the `pairView` debug render. */
  pairTraceOpts?: import('./pairTrace').PairTraceOptions;
  /** Which tracer the faint-rules RESCUE snaps its seeds with: 'pair'
   *  (default — pairTraceRules' propagation sweep, clean/pairTrace.ts) or
   *  'seam' (the banded per-seed refineRuleTrace + improveRules pass).
   *  Rescue-only: pages whose printed rules trace plausibly never read this. */
  rescueTracer?: 'pair' | 'seam';
  /** When the faint-rules rescue may run. 'auto' (default) applies the two
   *  triggers below; 'force' runs it whatever the trace looked like, and 'off'
   *  keeps the tracer's own rules. Diagnostic — a page is not expected to need
   *  either override, and `--set` on the harness is how they get measured. */
  rulesRescue?: 'auto' | 'force' | 'off';
  /** Complete the traced rule grid from its own pitch (default true) — see
   *  `completeRuleGrid`. false keeps only what the detectors found. */
  ruleGrid?: boolean;
  /** Compute the TS page-corner candidates ('rules'/'border', clean/pageQuad.ts)
   *  on the ORIGINAL photo and attach them as `quadCands` (default true;
   *  ~80 ms). They change nothing — the labs draw them, edgescore scores them
   *  against hand labels, and a measured flip of the default detector comes
   *  later or not at all. */
  quadCands?: boolean;
  /**
   * HAND-PAINTED ink override (clean/inkPaint.ts), in PAGE coordinates
   * (`pass.pageW x pass.pageH` — the frame `segPage` and the rec boxes live
   * in). PAINT_ADD says "count anything darkish here as text and do not let
   * the acceptance gate drop it"; PAINT_CUT says "this is not text, erase it".
   *
   * The mask is only meaningful against ONE Pass A run: page coordinates come
   * out of the dewarp, so a mask painted on this photo at these options means
   * nothing under different ones. `inkPaintKey` is the check a caller holding
   * a mask across re-runs should make.
   */
  inkPaint?: InkPaint;
  /** Component ownership verdicts the RECOGNIZER overrode (page.mjs
   *  arbitrateWelds): a weld or deep descender geometry gave to one line is
   *  re-assigned to the line it reads best on. Pixel-keyed, so the same list
   *  names the same components to every consumer of this page's segPage. */
  ownershipOverrides?: OwnershipOverride[];
  /** Manual word-break gap in px. 0 = cluster the gaps automatically. Default 35. */
  wordGap?: number;
  /** How separated the two auto gap clusters must be to accept a split. Default 0.38. */
  gapSeparation?: number;
  /**
   * Override individual Pass B parameters (keys from `passBParams`).
   *
   * Pass B was the one stage with no way in: everything else on this interface
   * is reachable, but the per-word normalization always ran
   * `passBParams.paramObject()` verbatim, so a question like "does this word
   * merge because the stroke is being rendered too thick?" could not be asked
   * from a lab at all — only by editing the defaults and rebuilding. The
   * interesting ones are `tnTarget` (goal stroke thickness in px, 0 = page
   * median), `tnSurface` (ink-coverage level treated as the stroke boundary;
   * HIGHER renders thinner) and `tnMaxChange`.
   */
  passB?: Record<string, number>;
  /**
   * Goal stroke thickness as a FRACTION of the normalized x-height (e.g. 0.2
   * renders every word's strokes at 20% of `targetXh`). Translated to
   * `passB.tnTarget` pixels once `normalizeHeights` has fixed `targetXh` —
   * the px value cannot be known before that stage, which is why this cannot
   * be expressed through `passB` alone. An explicit `passB.tnTarget` wins.
   * Unset = the shipped default (tnTarget's own px default).
   */
  thicknessXh?: number;
  /**
   * What KIND of paper this is: ruled, plain, grid, dot grid (`PAGE_TEMPLATES`).
   *
   * `'auto'` (the default) reads it off the page with `classifyTemplate` and
   * falls back to the historical default — ruled with a left margin — when the
   * evidence is weak, because acting on an unsure guess about the paper is
   * worse than not acting: a template CHANGES Pass A's parameters, so a wrong
   * one turns the rule stage off on ruled paper, or leaves it on for plain.
   *
   * Pass a template id (or a `PageTemplate` of your own) to commit to one.
   * `'ruled-margin'` is the historical behaviour exactly — its parameter
   * override set is empty — so selecting it can never move a pixel.
   */
  template?: PageTemplateId | PageTemplate | 'auto';
  /** Dump per-stage diagnostics to the console. Defaults to the
   *  `hw-pipeline-v2-debug` localStorage flag when running in a browser. */
  debug?: boolean;
  /** Record per-stage wall time on the result (`timings`, ms). Off by default;
   *  zero cost when off. `scripts/clean-fingerprint.mjs --profile` prints it. */
  profile?: boolean;
}

export interface CleanPageTemplateResult {
  /** The template the cleanup actually ran with. */
  template: PageTemplate;
  /** True when it came from the classifier rather than from the caller. */
  auto: boolean;
  /** What the classifier said, with its evidence — reported even when the caller
   *  supplied a template, so a lab can show what auto would have picked. */
  detected: TemplateChoice;
  /** Pass A had to be run a second time because the template changed its
   *  parameters. Empty-override templates (`ruled-margin`) never do. */
  rerun: boolean;
  /** The vertical lattice found on grid paper, if any — one entry per printed
   *  line, in the same shape the rule remover consumes. */
  vLatticeLines: number;
  /** Printed dots erased, on dot-grid paper. */
  dotsErased: number;
  /** Text lines found from the INK because the paper had no printed rules.
   *  0 on ruled paper, where the rules supply them. */
  inkBaselines: number;
}

export interface DewarpStepDebug {
  /** validation coverage of this rule's trace, 0..1 */
  conf: number;
  medianY: number;
  applied: boolean;
  maxDev: number;
  w: number;
  h: number;
  /** the page warped by the top-k rules, downscaled to w x h */
  gray: Uint8Array;
  /** this rule's ORIGINAL trace, sampled every `traceStep` px at snapshot scale */
  trace: number[];
  traceStep: number;
}

export interface PairTraceDebug {
  w: number;
  h: number;
  /** the PRE-dewarp page, downscaled to w x h — the frame the traces live in */
  gray: Uint8Array;
  /** one trace per rule from the experimental pair tracer, sampled every
   *  `traceStep` px at snapshot scale */
  traces: number[][];
  traceStep: number;
}

export interface CleanPageResult {
  /** One record per word, carrying the cleaned crop in `smooth`. Words the
   *  pipeline could not resolve have status 'empty' and no crop. */
  recs: passB.WordRec[];
  /** Formatting symbols found in the margin strip (left, or right for a
   *  right-hand-margin template), keyed to `WordRec.line`. */
  marginMarks: MarginMark[];
  /** The page's median x-height after normalization, in px. Callers scale text
   *  to this to keep imported words the same visual size as their own. */
  targetXh: number;
  /** The Pass A output, for callers that want the flattened page or rules. */
  pass: PassAResult;
  /** The page a LINE-level recognizer should read, `pass.pageW x pass.pageH`:
   *  rules erased, then every character re-rendered at one normalized darkness
   *  on pure paper (the segmenter's per-character clean render — the same
   *  regime the word/line/code trainers export). Unlike the per-word crops it
   *  keeps page-level geometry (no per-word leveling), and it is built before
   *  the word-level edge filter, so ink from a wrongly-dropped word is still
   *  present for a decoder that re-segments from pixels. Raw-strip and
   *  crop-composite alternatives were both measured worse (see
   *  server/public/wordgpu/page.mjs). */
  segPage: Uint8Array;
  /** What the rule-guided dewarp did — always reported, applied or not, so a
   *  caller can show what was (or was not) flattened and why. */
  dewarp: DewarpResult;
  /** Per-rule dewarp snapshots (only when `opts.dewarpSteps`): most-confident
   *  rule first, each entry the page warped by the top-k rules alone, with the
   *  rule's ORIGINAL (curved) trace at snapshot scale. */
  dewarpSteps?: DewarpStepDebug[];
  /** Experimental pair-coupled traces (clean/pairTrace.ts), only when
   *  `opts.dewarpSteps` and the faint-rule rescue supplied seeds. Display
   *  only — production tracing does not use them. */
  pairView?: PairTraceDebug;
  /** What the edge-shadow lift did (clean/shadows.ts); `lifted` px, or why not. */
  edgeShadows: EdgeShadowResult;
  /** Page-corner candidates from the TS approaches (clean/pageQuad.ts), in
   *  ORIGINAL photo pixels. Display/scoring only — nothing downstream reads
   *  them yet; a measured flip of the detector comes via edgescore. */
  quadCands: QuadCandidate[];
  /** removeHRulesPage's per-pixel verdicts, `pass.pageW x pass.pageH` —
   *  0 untouched · 1 erased as printed rule · 2 kept as the writer's stroke.
   *  Consumed by growInkSet so refinement growth cannot regrow the rules. */
  ruleCls: Uint8Array;
  /** display-only rule-residue pixel indices — see the result assembly note */
  stripResidue?: number[];
  /** The rule-removed grayscale page `segPage` is re-rendered from. */
  ruleRemoved: Uint8Array;
  /** Dot-sized marks the segmenter refused — metadata for `restoreDots` once a
   *  caller has RECOGNIZED the page; never present in `segPage` itself. */
  dotCandidates: DotCandidate[];
  /** Flat in-band strips that LOOK like rule residue (shoulder smears,
   *  doubled-rule segments) — metadata for a decode-keyed removal, because
   *  this writer's flat letter-bottom drags overlap them in every cheap
   *  feature. Present IN segPage until a caller erases the ones no fitted
   *  character claims (the editor's removeStripResidue). */
  flatStripCandidates: FlatStripCandidate[];
  /** Per-pixel component-ownership mask (`rec.line` + 1; 0 = keep), already
   *  applied to the Pass B crops — `ownershipMask` over segPage's components.
   *  Carried so a caller re-cutting crops later (merge/split/refit) can apply
   *  the same trim. Absent when the page has fewer than two word lines. */
  lineMask?: Int16Array;
  /** The ownership verdicts the crops were masked with (incl. `twoLine`, the
   *  welds a recognizer may re-arbitrate). */
  ownership?: ComponentOwnership;
  /** The SEGMENTER's own per-pixel line assignment (segmenter line index + 1;
   *  0 = unclaimed) — seam-aware where `separateCrossLine` cut a two-line
   *  weld. NOTE the id space differs from `lineMask`: translate through
   *  `segLineIds` (BoxesJson line index -> segmenter line index). Consumed by
   *  `componentOwnership` as a letter-sized-component prior. */
  segLineMask?: Int16Array;
  segLineIds?: number[];
  /** Which page template was used, how it was chosen, and what it did. */
  template: CleanPageTemplateResult;
  /** Per-stage wall time in ms, only when `opts.profile` — the stage names are
   *  the `mark()` calls in `cleanPage`, in pipeline order. Pass A is counted as
   *  a whole per run (`passA`, `dewarpCheck`, `template`) because it runs in
   *  the worker. */
  timings?: Record<string, number>;
}

/**
 * Run the full cleanup on one image's pixels.
 *
 * Takes raw RGBA rather than an HTMLImageElement so the caller decides how to
 * decode — a DOM canvas, an OffscreenCanvas in a worker, or a decoder in Node.
 */
export function cleanPage(image: ImageData, opts?: CleanPageOptions): Promise<CleanPageResult>;
export function cleanPage(rgba: Uint8ClampedArray, w: number, h: number, opts?: CleanPageOptions): Promise<CleanPageResult>;
export async function cleanPage(
  rgbaOrImage: Uint8ClampedArray | ImageData,
  wOrOpts?: number | CleanPageOptions,
  hArg?: number,
  optsArg: CleanPageOptions = {},
): Promise<CleanPageResult> {
  // An ImageData (what getImageData returns) is accepted whole: cleanPage(image, opts?).
  const isImage = !!rgbaOrImage && typeof rgbaOrImage === 'object' && !ArrayBuffer.isView(rgbaOrImage)
    && 'data' in rgbaOrImage && 'width' in rgbaOrImage && 'height' in rgbaOrImage;
  const rgba = isImage ? (rgbaOrImage as ImageData).data : rgbaOrImage as Uint8ClampedArray;
  const w = isImage ? (rgbaOrImage as ImageData).width : wOrOpts as number;
  const h = isImage ? (rgbaOrImage as ImageData).height : hArg as number;
  const opts: CleanPageOptions = (isImage ? (wOrOpts as CleanPageOptions | undefined) : optsArg) ?? {};
  checkImage(rgba, w, h);
  // ONE Pass A worker for the whole call: the photo is copied to it once, and
  // every Pass A run below (the probe, the dewarp check, a template re-run)
  // reuses it. Opened before the corner candidates so the worker's module
  // load overlaps that JS work in a browser.
  const session = openPassA(rgba, w, h);
  try {
    return await cleanPageWith(session, rgba, w, h, opts);
  } finally {
    session.close();
  }
}

async function cleanPageWith(
  session: PassASession,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: CleanPageOptions,
): Promise<CleanPageResult> {
  // Stage timer. `mark(name)` charges the time since the previous mark to
  // `name`; a name that recurs (a second Pass A run) accumulates.
  const timings: Record<string, number> | undefined = opts.profile ? {} : undefined;
  let tPrev = timings ? performance.now() : 0;
  const mark = (name: string): void => {
    if (!timings) return;
    const now = performance.now();
    timings[name] = (timings[name] ?? 0) + (now - tPrev);
    tPrev = now;
  };
  // Corner CANDIDATES on the raw photo (clean/pageQuad.ts) — attached for the
  // labs and for edgescore; they steer nothing here yet.
  let quadCands: QuadCandidate[] = [];
  if (opts.quadCands !== false) {
    try { quadCands = quadCandidates(rgba, w, h); } catch { quadCands = []; }
  }
  mark('quadCands');
  // THE FUSED CANDIDATE DRIVES THE PAGE QUAD (measured Aug 25 on the first
  // annotated corner corpus: fused 0.21% mean corner error vs the WASM
  // detector's 4.70%). Its `snapped` flags say which sides are REAL edges:
  //   - all four fitted   -> those are the paper's corners: perspective-warp,
  //                          and the rule-flatness check below still
  //                          arbitrates (corners alone never decide a warp);
  //   - some fitted       -> partial corners never keystone-warp: crop to the
  //                          quad's axis-aligned bounds and let the
  //                          rule-guided dewarp own the geometry;
  //   - none fitted       -> the sheet fills the frame: full frame, no warp
  //                          (the old detector warped to a bogus interior
  //                          quad on exactly these pages).
  // `quadPick: 'wasm'` restores the WASM detector (with the overflow-crop
  // arbitration), `quadUse: 'warp'` the old warp-regardless path.
  let cropQuad: number[] | undefined;
  let activeQuad: number[] | undefined = opts.skipDewarp ? undefined : opts.manualQuad;
  let appliedCrop = false;      // a partial-corner crop was applied: skip the check
  const bboxRect = (q: number[], W: number, H: number): number[] | undefined => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      x0 = Math.min(x0, q[i * 2]); x1 = Math.max(x1, q[i * 2]);
      y0 = Math.min(y0, q[i * 2 + 1]); y1 = Math.max(y1, q[i * 2 + 1]);
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);
    // under half the frame is a detection failure, not a crop; within ~1% of
    // the whole frame there is nothing worth a manual-quad pass
    if (x1 - x0 < W * 0.5 || y1 - y0 < H * 0.5) return undefined;
    if (x0 < W * 0.01 && y0 < H * 0.01 && x1 > W * 0.99 && y1 > H * 0.99) return undefined;
    return [x0, y0, x1, y0, x1, y1, x0, y1];
  };
  if (!opts.skipDewarp && !opts.manualQuad && opts.quadUse !== 'warp') {
    try {
      const det = await session.detectQuad();
      const sx = det.grayW / w, sy = det.grayH / h;
      const fused = opts.quadPick !== 'wasm'
        ? quadCands.find((c) => c.method === 'fused') : undefined;
      if (fused) {
        const gq = fused.quad.map((v, i) => v * (i % 2 ? sy : sx));
        const nFit = fused.snapped.filter(Boolean).length;
        if (nFit === 4) {
          activeQuad = gq;
          cropQuad = bboxRect(gq, det.grayW, det.grayH);   // the check's fallback
        } else if (nFit > 0) {
          // PARTIAL CORNERS: crop to the quad's bounds through the manual-quad
          // path, never keystone. MEASURED (all real photos): 73/1927 corpus +
          // weirdpage 25/52 — better than every alternative tried: an in-crop
          // AUTO re-detect re-guessed a warp (weirdpage 25 -> 50), and
          // PAGE_ENABLE=0 degrades the tracing stages. The manual path's
          // homography resample is harmless on photographs; it is visible only
          // on sub-pixel-crisp SYNTHETIC pages, which is why the template
          // gate's classification cases pin quadPick: 'wasm'.
          const bb = bboxRect(gq, det.grayW, det.grayH);
          if (bb) { activeQuad = bb; appliedCrop = true; }
        }
        // fused all-frame (or nothing croppable): the auto path plus the
        // overflow-crop arbitration below, exactly the pre-fused behaviour.
      }
      if (!activeQuad && !appliedCrop && det.quadFound && det.quadOverflow) {
        // An overflow quad's bounds are a real crop (the bright region hugs
        // the borders). A non-overflow wrong quad's bounds inherit the
        // wrongness (measured photo 21 -> 58) — full-frame fallback for those.
        cropQuad = bboxRect(det.quad, det.grayW, det.grayH);
      }
    } catch { /* detector unavailable — the auto path decides as before */ }
  }
  mark('detectQuad');
  let usedFullFrame = false;
  // The parameter set every Pass A run starts from. It is the shared defaults
  // until a page template says otherwise, and then it is the template's — held
  // in a variable rather than threaded through because the dewarp fallback and
  // the resolution retry both re-enter `runA` and must not silently drop the
  // template that was chosen after them.
  let baseParams: Float32Array | null = null;
  const buildParams = (workDim?: number, fullFrame = false): Float32Array | undefined => {
    if (!baseParams && !opts.skipDewarp && !activeQuad && !fullFrame && workDim == null) return undefined;
    const q = baseParams ? Float32Array.from(baseParams) : passA.defaultParams();
    // fullFrame = keep every other stage (illumination, rules, binarize) and
    // only decline the geometric correction — NOT the same as skipDewarp, which
    // disables the whole page stage.
    if (opts.skipDewarp) q[PAGE_ENABLE_IDX] = 0;
    else if (fullFrame) q[PAGE_ENABLE_IDX] = 0;
    else if (activeQuad) q[PAGE_MANUAL_IDX] = 1;
    if (workDim != null) q[WORK_MAXDIM_IDX] = workDim;
    return q;
  };
  // `buildParams` answers undefined for "the shared defaults, no quad", which
  // is the same request as the defaults with no manual quad — `activeQuad` is
  // necessarily unset on that path.
  const requestFor = (workDim?: number, fullFrame = false): { params: Float32Array; quad?: number[] } => {
    const q = buildParams(workDim, fullFrame);
    return { params: q ?? passA.defaultParams(), quad: fullFrame || !q ? undefined : activeQuad };
  };
  const runA = async (workDim?: number, fullFrame = false): Promise<PassAResult> => {
    const r = requestFor(workDim, fullFrame);
    return session.run(r.params, r.quad);
  };

  // THE PROBE RUN IS SPLIT AT STAGE 4. The dewarp check below needs only the
  // flattened gray of each candidate (stages 1-4: resize, page, warp,
  // flatten — a tenth of Pass A), and the expensive half (rule tracing,
  // removal, binarize, despeckle) is then paid ONCE, for the winner, as a
  // continuation on the same worker. Before this the probe ran all eight
  // stages and the check ran all eight again, and on most corpus pages the
  // check's candidate won, so the probe's own tracing was the waste. Same
  // stages in the same order with the same parameters: the winner's result is
  // the full run's, byte for byte (gated by clean-fingerprint).
  const r0 = requestFor(opts.workMaxDim);
  const head0 = await session.runStages(r0.params, r0.quad, { stages: [1, 4], previews: [4] });
  let paRun: PassAResult | null = null;
  mark('passA');

  // DOES THE DEWARP ACTUALLY HELP? The page-quad detector reports success on
  // any four corners it can fit, including the IMAGE BORDER — and these photos
  // are close-ups where the paper runs past every edge, so there is no page
  // rectangle to find. Measured on five labelled pages: two had a "found" quad
  // that warped a square, evenly-lit photo into a ~13-degree keystone, squashing
  // the page 17% vertically and bending every ruled line. Nothing downstream can
  // recover from that, and the failure is silent because the detector is sure.
  //
  // The ruled lines settle it. They are parallel on the paper, so after a good
  // dewarp their slope is the same at the top and bottom of the page; after a
  // bad one it swings. Measure both readings and keep the flatter, with a
  // margin so a genuinely angled photo still gets its correction.
  // The fallback when the warp fails this check used to be the FULL FRAME,
  // which threw the crop away with the keystone. It is now the detector
  // quad's axis-aligned CROP when one exists (`cropQuad` above): same flat
  // geometry as the frame — a rectangle cannot keystone — but the rim is
  // still dropped, and the rule-guided dewarp handles what the writer
  // actually wrote on. Corners alone never decide a warp; the rules do.
  if (!opts.skipDewarp && !opts.manualQuad && !appliedCrop
    && opts.autoDewarpCheck !== false) {
    const warpQuad = activeQuad;   // what the surviving warp should keep using
    const before = ruleSlopeSwing(head0.gray!, head0.pageW, head0.pageH);
    if (before.swing > 0.05) {
      if (cropQuad) activeQuad = cropQuad;
      const r1 = requestFor(opts.workMaxDim, !cropQuad);
      const head1 = await session.runStages(r1.params, r1.quad, { stages: [1, 4], previews: [4] });
      const after = ruleSlopeSwing(head1.gray!, head1.pageW, head1.pageH);
      if (after.swing < before.swing - 0.02) {
        // the candidate's stages 1-4 are what the worker holds: continue it
        const tail1 = await session.runStages(r1.params, r1.quad, { stages: [5, 8], previews: [8] });
        paRun = mergeStages(head1, tail1);
        usedFullFrame = !cropQuad;
      } else {
        if (cropQuad) activeQuad = warpQuad;   // the warp survived — put its quad back
        // the probe's own stages 1-4 were displaced by the candidate's: rerun it whole
        paRun = await session.run(r0.params, r0.quad);
      }
    }
  }
  if (!paRun) {
    // no check ran, or none was needed: the probe's stages 1-4 still stand
    const tail0 = await session.runStages(r0.params, r0.quad, { stages: [5, 8], previews: [8] });
    paRun = mergeStages(head0, tail0);
  }
  mark('dewarpCheck');

  // INK RUNNING INTO THE PAGE BOUNDARY means the quad cut through writing.
  // Measured on weirdpage: "How good" is written into the shadowed bend at
  // the paper's right edge, the detector fit the page side at the bend line,
  // and the warp amputated the d — the full letter exists in the photo just
  // past the crop. A LETTER-SIZED dark run touching the warped page's left or
  // right boundary is evidence the boundary is wrong (writing keeps a margin
  // from the true paper edge; only a cut letter runs into the crop), so the
  // page is re-run ONCE with that side of the quad pushed outward. Tall runs
  // are excluded — a binding shadow or rim at the boundary is a continuous
  // dark band, not letter-sized — and the retry keeps the wider result only
  // if the boundary ink actually shrank.
  // OPT-IN ONLY, measured net-harmful as a default: on weirdpage the widened
  // warp recovers the cut d PERFECTLY (verified visually) but admits an
  // 84-column band of curled-page shadow whose mottle floods segmentation
  // and the decode — 10 -> 28 word errors and ~100x decode time. Shipping
  // this on needs the admitted band masked outside the crossing ink, which
  // is its own round. `edgeInkRetry: true` runs it.
  if (!opts.skipDewarp && !usedFullFrame && opts.edgeInkRetry === true) {
    const edgeInkRuns = (g: Uint8Array, PW: number, PH: number, side: 'L' | 'R', lh: number): number => {
      // the amputated letter's stump ends short of the very boundary (quad
      // slant, edge blur, the warp's deliberate inset), so the probe reads a
      // BAND of columns, not just the outermost three
      const win = Math.max(3, Math.round(lh * 0.15));
      const xs: number[] = [];
      for (let i = 0; i < win; i++) xs.push(side === 'L' ? i : PW - 1 - i);
      const samp: number[] = [];
      for (let i = 0; i < PW * PH; i += 499) samp.push(g[i]);
      samp.sort((a, b) => a - b);
      const dark = (samp[Math.floor(samp.length * 0.85)] ?? 235) - 45;
      let runs = 0;
      for (const x of xs) {
        let run = 0;
        for (let y = 0; y < PH; y++) {
          if (g[y * PW + x] < dark) { run++; continue; }
          if (run >= lh * 0.2 && run <= lh * 1.3) runs++;
          run = 0;
        }
      }
      return runs;
    };
    const lh0 = paRun.lineHeight > 4 ? paRun.lineHeight : 50;
    const touchL = edgeInkRuns(paRun.gray, paRun.pageW, paRun.pageH, 'L', lh0);
    const touchR = edgeInkRuns(paRun.gray, paRun.pageW, paRun.pageH, 'R', lh0);
    // A binding shadow at one edge also reads as letter-sized runs, and
    // growing toward it makes that side WORSE — so each triggered side is
    // tried on its own and kept only if its own boundary ink shrank. One
    // side's failure must not veto the other's rescue.
    if ((touchL >= 3 || touchR >= 3) && activeQuad) {
      const baseQuad = activeQuad.slice();
      const xs = [0, 2, 4, 6].map((i) => baseQuad[i]);
      const pad = Math.round((Math.max(...xs) - Math.min(...xs)) * 0.04);
      // ACCEPTANCE is "does ink now CROSS the old cut line" — not "is the new
      // boundary clean", which it never is: past the paper lies the desk or
      // the curled next sheet, whose mottle reads as MORE boundary runs (the
      // first metric rejected the very retry that recovered the d). A cut
      // letter continues across the old boundary once the page widens; mottle
      // does not line up across it.
      const crossings = (g: Uint8Array, PW: number, PH: number, cutX: number, lh: number): number => {
        const samp: number[] = [];
        for (let i = 0; i < PW * PH; i += 499) samp.push(g[i]);
        samp.sort((a, b) => a - b);
        const dark = (samp[Math.floor(samp.length * 0.85)] ?? 235) - 45;
        const a = Math.max(1, cutX - 3), b = Math.min(PW - 2, cutX + 3);
        let rows = 0;
        for (let y = 0; y < PH; y++) {
          if (g[y * PW + a] < dark && g[y * PW + b] < dark) rows++;
        }
        return rows;
      };
      const attempt = async (side: 'L' | 'R', touched: number): Promise<boolean> => {
        const grown = baseQuad.slice();
        if (side === 'L') { grown[0] -= pad; grown[6] -= pad; }
        else { grown[2] += pad; grown[4] += pad; }
        activeQuad = grown;
        const retry = await runA(opts.workMaxDim);
        const rl = retry.lineHeight > 4 ? retry.lineHeight : lh0;
        const padOut = Math.round(pad * retry.pageW / (Math.max(...[0, 2, 4].map((i) => grown[i])) - Math.min(...[0, 2, 6].map((i) => grown[i])) || retry.pageW));
        const cutX = side === 'R' ? retry.pageW - 1 - padOut : padOut;
        const cross = crossings(retry.gray, retry.pageW, retry.pageH, cutX, rl);
        if (cross >= Math.max(4, Math.round(rl * 0.15))) {
          paRun = retry;
          return true;   // keep the widened quad in activeQuad
        }
        activeQuad = baseQuad.slice();
        return false;
      };
      if (touchR >= 3) await attempt('R', touchR);
      if (touchL >= 3) {
        const keptQuad = activeQuad.slice();
        if (!(await attempt('L', touchL))) activeQuad = keptQuad;
        else if (keptQuad !== baseQuad) {
          // both sides earned their growth — combine them in one final run
          const both = keptQuad.slice();
          both[0] -= pad; both[6] -= pad;
          activeQuad = both;
          paRun = await runA(opts.workMaxDim);
        }
      }
    }
  }

  // AUTO WORKING RESOLUTION — opt-in only; see `autoWorkDim` for why it is off.
  // Iterates because one step lands short: the requested long edge is the
  // SOURCE resize and page detection then crops, so the achieved line height
  // comes out below what was asked for. Never scales past what the original
  // photo holds — upsampling invents no strokes.
  if (opts.autoWorkDim === true && opts.workMaxDim == null) {
    let workDim = Math.max(paRun.pageW, paRun.pageH);
    for (let iter = 0; iter < 3 && paRun.lineHeight > 0; iter++) {
      const ratio = TARGET_LINE_H / paRun.lineHeight;
      if (ratio < 1.12) break;                       // close enough, or already bigger
      const want = Math.min(workDim * ratio, Math.max(w, h), WORK_MAXDIM_MAX);
      if (want <= workDim * 1.05) break;             // capped out — no more to gain
      workDim = Math.round(want);
      const retry = await runA(workDim, usedFullFrame);
      // A resolution change moves the rule tracer; keep the retry only if it
      // still sees a page at all.
      if (!(retry.lineHeight > 0)) break;
      paRun = retry;
    }
  }
  mark('retries');

  // PAGE TEMPLATE — what kind of paper is this?
  //
  // The classifier runs on the probe pass above, which used the shared defaults.
  // That is the right way round: the defaults trace rules and one vertical line,
  // which is exactly the evidence needed to tell ruled from plain from grid. A
  // template that disables the rule stage could not be classified from its own
  // output.
  //
  // Only a template with real parameter overrides costs a second Pass A. The
  // historical default — `ruled-margin` — overrides nothing, so the five-page
  // photo corpus takes this branch zero times and its output is untouched.
  const detected = classifyTemplate(paRun.gray, paRun.pageW, paRun.pageH, paRun.rules);
  const asked = opts.template ?? 'auto';
  let template: PageTemplate;
  let templateAuto = false;
  if (asked === 'auto') {
    templateAuto = detected.confidence >= AUTO_MIN_CONFIDENCE;
    template = templateAuto ? detected.template : templateById('ruled-margin')!;
  } else if (typeof asked === 'string') {
    const t = templateById(asked);
    if (!t) throw new Error(`unknown page template "${asked}"`);
    template = t;
  } else {
    // A caller may hand in a template of its own. `params` is what decides
    // whether Pass A re-runs, so a custom template missing it would otherwise
    // fail with a bare TypeError several lines from the actual mistake.
    if (!asked || typeof asked !== 'object' || !asked.params) {
      throw new Error('cleanPage: a custom page template needs a `params` object (may be empty)');
    }
    template = asked;
  }
  let rerun = false;
  if (Object.keys(template.params).length) {
    baseParams = templateParams(template);
    paRun = await runA(opts.workMaxDim, usedFullFrame);
    rerun = true;
    // The rule tracer is what `improveRules` and the removal stages read, and a
    // template that turned it off leaves them nothing to do — which is the
    // point, not a failure.
  }
  mark('template');
  // From here on Pass A's result is only READ, and mostly from inside
  // closures — the coverage scan, the rule scorer, the baseline band counts.
  // TypeScript narrows the `let` above in straight-line code but never inside
  // a callback, so the rest of the pipeline takes the result as a const.
  const pa: PassAResult = paRun;

  // Margin — locate the vertical margin line; exclude its strip from words.
  // (Glyph classification runs later, once word-line baselines are known.)
  // A template that says the paper has no margin skips this: on grid paper the
  // leftmost lattice line is not a margin, and treating it as one excludes the
  // whole first column of writing from segmentation.
  const { marginX, marginRightX, marginLeftX } = template.margin === 'none'
    ? { marginX: -1, marginRightX: 0, marginLeftX: 0 }
    : detectMarginLine(pa, template.margin);
  mark('margin');

  // GRID PAPER — find the whole vertical lattice and hand it to the ordinary
  // vertical-rule removal.
  //
  // Pass A traces exactly ONE vertical rule by construction (`seams.c` sets
  // `g.n_vrules = 1` and keeps the strongest candidate), which is right for a
  // margin and useless for graph paper: one line of twenty is erased and the
  // rest stay, welding letters to lines across the whole page. `detectVLattice`
  // finds them all in JS and emits them in `VRuleTrace` shape, so `removeVRules`
  // — which already handles the horizontal-rule crossings a grid is full of —
  // needs no change at all.
  let vLatticeLines = 0;
  if (template.gridV) {
    const lat = detectVLattice(pa.gray, pa.pageW, pa.pageH);
    if (lat) {
      pa.rules.vrules = lat.vrules;
      vLatticeLines = lat.vrules.length;
    }
  }

  // DOT GRID — erase the printed lattice before anything looks for ink.
  //
  // It has to happen here, on `pa.gray`, and not later: the dots are ink to
  // every stage downstream. `speckleMin` runs on the BINARIZED page and would
  // take some of them, but the segmenter reads the grayscale and would already
  // have grouped a row of dots into a word.
  //
  // The lattice is re-fitted here rather than reused from the classifier: a
  // template that overrode Pass A's parameters was run a SECOND time, so the
  // classifier's lattice describes a page that no longer exists, and a lattice
  // phase that is a pixel out erases nothing.
  let dotsErased = 0;
  if (template.dotted) {
    const lat = detectDotLattice(pa.gray, pa.pageW, pa.pageH);
    if (lat) dotsErased = removeDotLattice(pa.gray, pa.pageW, pa.pageH, lat);
  }
  mark('lattice');

  const p = { ...passBParams.paramObject(), ...(opts.passB ?? {}) } as ReturnType<typeof passBParams.paramObject>;

  // Improve the WASM-traced rules: catch any rule the tracer missed (row-ink), refine
  // each onto the real line, and measure real thickness. Used by BOTH the segmentation
  // rule removal and Pass B below, so update pa.rules in place.
  pa.rules.rules = improveRules(pa.gray, pa.pageW, pa.pageH, pa.rules.rules, pa.lineHeight);
  mark('improveRules');

  let rulesRebuilt = false;
  let inkPitchSeg = 0;   // the WRITING pitch the rescue measured (not the printed pitch)
  // the rescue's seed set, kept ONLY so the dewarpSteps debug emission can run
  // the experimental pair tracer on the same seeds and show both trace sets
  let rescueSeedsDbg: { seeds: number[]; pitch: number } | null = null;
  // THE TRACED RULES MUST EXPLAIN THE INK. On faint ruling the tracer can
  // return a handful of phantom rules with an absurd line height (weirdpage:
  // 4 rules at lineHeight 386 for 14 written lines ~105 px apart), and every
  // later stage inherits the wreck — line assignment collapses whole
  // paragraphs into one id, the segmentation thresholds all key on the wrong
  // height. The ink's own row profile is the arbiter (the same `inkBaselines`
  // the unruled-paper rescue trusts): when the traced rules cannot account
  // for the written lines — far fewer rules than ink lines, or a line height
  // far above the ink's own pitch — the rules are REBUILT from the ink:
  // flat seeds at the ink baselines, re-refined by `improveRules` so they
  // snap onto whatever faint print is really there. A page whose tracer
  // worked never trips this (its rule count covers the written lines), which
  // the corpus gate verifies byte-identically.
  {
    const ink = inkBaselines(pa.gray, pa.pageW, pa.pageH, 0);
    if (ink.length >= 4) {
      const inkGaps = ink.slice(1).map((y, i) => y - ink[i]).sort((a, b) => a - b);
      const inkPitch = inkGaps[inkGaps.length >> 1] || 0;
      // BOTH symptoms must agree — a count deficit alone fires on healthy
      // pages whose ink profile over-counts (the synthetic template gate
      // caught exactly that: ruled pages reclassified as plain because the
      // rescue had replaced their good rules). A near-empty trace with real
      // ink is the one exception.
      // Unruled paper (no traced rules at all) keeps the ink-baselines
      // fallback below — the rescue exists for rules that are WRONG, not
      // absent, and firing on zero rules left junk that blocked the
      // fallback (the template gate caught it). The floor is >= 1, NOT 2:
      // a single phantom rule fell through BOTH safety nets (too many for
      // the unruled fallback, too few for the rescue) and the editor's import
      // of weirdpage collapsed to 3 words on exactly that — its browser
      // decode of the same JPEG traced 1 phantom where ocrlab's traced 4,
      // the coin-flip family on a page whose every rule is faint.
      const implausible = inkPitch > 4 && pa.rules.rules.length >= 1
        && pa.rules.rules.length < ink.length * 0.5
        && pa.lineHeight > inkPitch * 1.8;
      // …AND THE SECOND SYMPTOM: the right NUMBER of rules at the right pitch,
      // sitting in the wrong PLACE. The count test above cannot see this —
      // risks1 traced 18 rules at a 45 px pitch against a 45 px ink pitch and
      // still left the top EIGHT written lines with no rule within half a
      // pitch, because every candidate row the WASM tracer seeds from comes out
      // of the leftmost w/8 of the page and its acceptance bar is a fraction of
      // the BEST pair's mean line-energy (`seams.c` find_candidates/pair_pass).
      // A rule crossing dense writing carries less clean line-energy than one
      // running over blank paper, so on a page that is written at the top and
      // empty at the bottom the empty half sets the bar and the written half
      // fails it — the rules are found exactly where they are not needed.
      // The ink is the arbiter here too, but the question is COVERAGE rather
      // than count: how many written rows have no rule near them. Only rows
      // above the last one carrying real WRITING are asked about — a blank
      // lower half is full of faint print that `inkBaselines` reports as ink,
      // and counting those rows as uncovered would fire on healthy pages.
      let uncovered = 0;
      let inkRows = 0;
      if (inkPitch > 4 && pa.rules.rules.length >= 2) {
        const rys = pa.rules.rules.map((r) => {
          const t = r.y.slice().sort((a, b) => a - b);
          return t.length ? t[t.length >> 1] : 0;
        });
        // the written region: rows whose ink is DARK (writing, not print).
        // paperLevel's own definition (pageTemplate.ts), inlined rather than
        // exported — one sampled 85th percentile, no state.
        const samp: number[] = [];
        for (let i = 0; i < pa.gray.length; i += 997) samp.push(pa.gray[i]);
        samp.sort((a, b) => a - b);
        const paperNow = samp.length ? (samp[Math.floor(samp.length * 0.85)] || 235) : 235;
        const writeT = paperNow - 70;
        const isWritten = (y: number): boolean => {
          const y0 = Math.max(0, Math.round(y) - 3);
          const y1 = Math.min(pa.pageH - 1, Math.round(y) + 3);
          let n = 0;
          for (let yy = y0; yy <= y1; yy++) {
            const row = yy * pa.pageW;
            for (let x = 0; x < pa.pageW; x += 2) if (pa.gray[row + x] < writeT) n++;
          }
          return n >= 20;
        };
        const written = ink.filter(isWritten);
        for (const y of written) {
          inkRows++;
          if (!rys.some((ry) => Math.abs(ry - y) <= inkPitch * 0.5)) uncovered++;
        }
      }
      const uncoveredInk = inkRows >= 4 && uncovered >= 3 && uncovered >= inkRows * 0.25;
      const rescue = opts.rulesRescue ?? 'auto';
      if (rescue !== 'off' && (rescue === 'force' || implausible || uncoveredInk)) {
        if (uncoveredInk && !implausible)
          debugLog(`[hw v2] rules do not cover the ink — ${uncovered}/${inkRows} written rows `
            + `have no rule within ${(inkPitch * 0.5).toFixed(0)}px; rebuilding`);
        // Flat seeds at the ink baselines, the gaps between them filled and
        // the blank rules above/below extended at the ink pitch — PLUS a
        // midpoint seed between every pair (the writer may use every OTHER
        // printed rule). Which seeds are real is decided by the PAGE: each is
        // snapped with the banded seam (`refineRuleTrace` follows curvature a
        // flat trace misses; improveRules refines only its OWN detections and
        // cannot see rules this faint), then VALIDATED by how much of its
        // length runs dark. The whole derivation is a function so it can run
        // TWICE: once on the raw page, and — anchored on the most confident
        // rules — again on a straightened page, where the weak rules' seams
        // stop being defeated by the very curvature the strong rules can
        // remove (weirdpage bends 27 px against a quarter-pitch snap band of
        // ~7, so a one-shot snap clamps at the page edges by construction).
        const rebuild = (): { rules: { thickness: number; y: number[] }[]; conf: number[]; pitch: number } | null => {
          const inkNow = inkBaselines(pa.gray, pa.pageW, pa.pageH, 0);
          if (inkNow.length < 4) return null;
          const gapsNow = inkNow.slice(1).map((y, i) => y - inkNow[i]).sort((a, b) => a - b);
          const pitch = gapsNow[gapsNow.length >> 1] || 0;
          if (pitch <= 4) return null;
          const ys: number[] = [];
          for (let i = 0; i < inkNow.length; i++) {
            if (i > 0) {
              const gap = inkNow[i] - inkNow[i - 1];
              const k = Math.max(1, Math.round(gap / pitch));
              for (let j = 1; j < k && j < 12; j++) ys.push(inkNow[i - 1] + (gap * j) / k);
            }
            ys.push(inkNow[i]);
          }
          for (let y = inkNow[0] - pitch; y >= pitch * 0.4 && ys.length < 60; y -= pitch) ys.unshift(y);
          for (let y = inkNow[inkNow.length - 1] + pitch; y <= pa.pageH - pitch * 0.3 && ys.length < 60; y += pitch) ys.push(y);
          const seeds: number[] = [];
          for (let i = 0; i < ys.length; i++) {
            if (i > 0) seeds.push((ys[i - 1] + ys[i]) / 2);
            seeds.push(ys[i]);
          }
          // Snap the seeds to the page. 'pair' (default) is pairTraceRules'
          // propagation sweep — pair-coupled line-ness DP, then re-traced
          // outward from the most confident rule in a narrow residual band
          // with a flatness prior (clean/pairTrace.ts). Earlier attempts to
          // ship it measured ~50 errors against the seam's 25 BEFORE the
          // xhOverride/gap-pooling fixes landed; it is re-measured under the
          // decode gate with each round, and 'seam' keeps the banded
          // per-seed refineRuleTrace + improveRules pass for A/B.
          rescueSeedsDbg = { seeds: seeds.slice(), pitch };
          let refined: { thickness: number; y: number[] }[];
          if ((opts.rescueTracer ?? 'pair') === 'pair') {
            refined = pairTraceRules(pa.gray, pa.pageW, pa.pageH, seeds, pitch,
              opts.pairTraceOpts ?? {});
          } else {
            const bandHalf = Math.max(4, Math.round(pitch / 8));
            const snapped = seeds.map((y) => ({
              thickness: 2,
              y: refineRuleTrace(pa.gray, pa.pageW, pa.pageH, Math.round(y), bandHalf),
            }));
            refined = improveRules(pa.gray, pa.pageW, pa.pageH, snapped, Math.round(pitch / 2));
          }
          const samp: number[] = [];
          for (let i = 0; i < pa.pageW * pa.pageH; i += 499) samp.push(pa.gray[i]);
          samp.sort((a, b) => a - b);
          const paper2 = samp[Math.floor(samp.length * 0.85)] ?? 235;
          const coverageOf = (r: { y: number[] }): number => {
            let dark = 0, n = 0;
            for (let x = 0; x < pa.pageW; x += 3) {
              const yy = Math.round(r.y[Math.min(x, r.y.length - 1)] ?? 0);
              if (yy < 2 || yy >= pa.pageH - 2) continue;
              n++;
              let v = 255;
              for (let dy = -2; dy <= 2; dy++) v = Math.min(v, pa.gray[(yy + dy) * pa.pageW + x]);
              if (v < paper2 - 8) dark++;
            }
            return n > 20 ? dark / n : 0;
          };
          const cov = refined.map(coverageOf);
          const rules = refined.filter((_, i) => cov[i] >= 0.5);
          const conf = cov.filter((c) => c >= 0.5);
          if (rules.length < 2) return { rules: refined, conf: cov, pitch };
          return { rules, conf, pitch };
        };
        const pass1 = rebuild();
        if (pass1) {
          // An ANCHORED SECOND PASS (straighten by the confident rules, then
          // re-derive on the flatter page) was tried here and MEASURED WORSE:
          // weirdpage 25 -> 48 word errors despite clean-looking segmentation
          // — the double warp moves the ink under every later stage in ways
          // the diag render does not show. Single pass ships; the ocrlab
          // "Rule dewarp, rule by rule" panel exists to diagnose the residual
          // trace errors before re-attempting any iteration.
          const finalSet = pass1;
          pa.rules.rules = finalSet.rules;
          const keptYs = pa.rules.rules.map((r) => {
            const t = r.y.slice().sort((a, b) => a - b);
            return t.length ? t[t.length >> 1] : 0;
          }).sort((a, b) => a - b);
          const keptGaps = keptYs.slice(1).map((y, i) => y - keptYs[i]).filter((g) => g > 4).sort((a, b) => a - b);
          pa.lineHeight = Math.round(keptGaps[keptGaps.length >> 1] || finalSet.pitch);
          debugLog(`[hw v2] rules implausible — rebuilt from ink: ${pa.rules.rules.length} rules, `
            + `line height ${pa.lineHeight}px`);
          rulesRebuilt = true;
          inkPitchSeg = inkPitch;
        }
      }    }
  }
  mark('rulesRescue');

  // COMPLETE THE GRID (clean/ccWordSeg.ts). Both detectors that produced the
  // set above score a rule by how easy it is to SEE, so the ones they miss are
  // systematically the ones under dense writing or at a weakly-flattened edge —
  // and on a page written at the top and blank below, that is the half that
  // needed removing (warehouse1 lost its top 3 rules, risks1 its top 8, both
  // having traced a clean grid over the empty paper underneath). Where the set
  // agrees on a pitch the missing positions are KNOWN and only need confirming.
  //
  // AFTER the rescue, deliberately. Run before it, this extends whatever the
  // tracer returned — on weirdpage that is four phantom rules 272px apart, and
  // a fifth phantom is not an improvement. The rescue decides whether the
  // traced set is worth believing; this fills in whichever set survived.
  if (opts.ruleGrid !== false) {
    const grid = completeRuleGrid(pa.gray, pa.pageW, pa.pageH, pa.rules.rules);
    const added = grid.above + grid.below + grid.filled;
    if (added) {
      pa.rules.rules = grid.rules;
      debugLog(`[hw v2] rule grid completed at pitch ${grid.pitch.toFixed(1)}px: `
        + `+${grid.above} above, +${grid.filled} in gaps, +${grid.below} below `
        + `(${grid.rejected} predicted positions had no print)`);
    }
  }
  mark('ruleGrid');

  // PER-RULE DEWARP STEPS, for ocrlab (opts.dewarpSteps): the final rule set
  // ordered most-confident-first, and for each prefix the page as it would
  // look warped by those rules alone — the intermediate states a one-shot
  // warp never shows. Debug-only: K extra warps of a scratch copy plus a
  // half-resolution snapshot each; production never pays for it.
  let dewarpSteps: DewarpStepDebug[] | undefined;
  let pairView: PairTraceDebug | undefined;
  if (opts.dewarpSteps && pa.rules.rules.length >= 2) {
    const W2 = pa.pageW, H2 = pa.pageH;
    const samp: number[] = [];
    for (let i = 0; i < W2 * H2; i += 499) samp.push(pa.gray[i]);
    samp.sort((a, b) => a - b);
    const paperD = samp[Math.floor(samp.length * 0.85)] ?? 235;
    const covOf = (r: { y: number[] | Float32Array }): number => {
      let dark = 0, n = 0;
      for (let x = 0; x < W2; x += 3) {
        const yy = Math.round(Number(r.y[Math.min(x, r.y.length - 1)]) || 0);
        if (yy < 2 || yy >= H2 - 2) continue;
        n++;
        let v = 255;
        for (let dy = -2; dy <= 2; dy++) v = Math.min(v, pa.gray[(yy + dy) * W2 + x]);
        if (v < paperD - 8) dark++;
      }
      return n > 20 ? dark / n : 0;
    };
    const scored = pa.rules.rules.map((r) => ({ r, conf: covOf(r) }))
      .sort((a, b) => b.conf - a.conf).slice(0, 40);
    const scale = Math.min(1, 640 / W2);
    const dw = Math.max(8, Math.round(W2 * scale)), dh = Math.max(8, Math.round(H2 * scale));
    const shrink = (g: Uint8Array): Uint8Array => {
      const out = new Uint8Array(dw * dh);
      for (let y = 0; y < dh; y++) {
        const sy = Math.min(H2 - 1, Math.round(y / scale));
        for (let x = 0; x < dw; x++) {
          out[y * dw + x] = g[sy * W2 + Math.min(W2 - 1, Math.round(x / scale))];
        }
      }
      return out;
    };
    dewarpSteps = [];
    for (let k = 1; k <= scored.length; k++) {
      const work = pa.gray.slice();
      const subset = scored.slice(0, k).map((s2) => ({ thickness: s2.r.thickness, y: Array.from(s2.r.y, Number) }));
      const dr = dewarpByRules(work, [], W2, H2, subset);
      const step = scored[k - 1];
      const trace: number[] = [];
      const TS = 8;
      for (let x = 0; x < W2; x += TS) {
        trace.push(Number(step.r.y[Math.min(x, step.r.y.length - 1)]) * scale);
      }
      const ys2 = Array.from(step.r.y, Number).slice().sort((a, b) => a - b);
      dewarpSteps.push({
        conf: +step.conf.toFixed(3),
        medianY: Math.round(ys2[ys2.length >> 1] ?? 0),
        applied: dr.applied,
        maxDev: +dr.maxDev.toFixed(1),
        w: dw, h: dh, gray: shrink(work),
        trace, traceStep: TS * scale,
      });
    }
    // EXPERIMENTAL PAIR-COUPLED TRACES beside the production ones, same page
    // snapshot — only when the rescue supplied seeds (this is the page family
    // the pair tracer is for). Debug-only; production tracing is unchanged.
    if (rescueSeedsDbg) {
      const sd = rescueSeedsDbg as { seeds: number[]; pitch: number };
      const pt = pairTraceRules(pa.gray, W2, H2, sd.seeds, sd.pitch, opts.pairTraceOpts ?? {});
      const TS = 8;
      pairView = {
        w: dw, h: dh, gray: shrink(pa.gray), traceStep: TS * scale,
        traces: pt.map((r) => {
          const t: number[] = [];
          for (let x = 0; x < W2; x += TS) t.push(+(r.y[Math.min(x, r.y.length - 1)] * scale).toFixed(1));
          return t;
        }),
      };
    }
  }

  // RULE-GUIDED DEWARP. The quad stage corrects perspective; paper CURVATURE
  // survives it, and the corpus bends up to 0.6 line heights — a letter resting
  // on the curved rule then measures half a line off the flat baseline every
  // later stage assumes. The refined traces are themselves the calibration:
  // remap each column so every rule becomes straight at its median y (traces
  // rewritten flat), applied to gray + clean + flat together so Pass B, the
  // segmenter and the labs share one geometry. See clean/dewarpRules.ts for
  // the no-op guards.
  const dewarp = dewarpByRules(pa.gray, [pa.clean.data, pa.flat.data],
    pa.pageW, pa.pageH, pa.rules.rules);
  mark('dewarp');

  // EDGE SHADOWS OFF THE PAGE. A curled page's own shadow, the phone's, or a
  // strip of dark background the crop kept — Pass A's flatten leaves them,
  // downstream they binarize as ink (the phantom-word family the edge-junk
  // filter fights) and they ship in the cleaned display. Thickness is the
  // discriminator: no pen stroke is dark for more than a few px in BOTH
  // directions, a shadow band is in both — so writing inside a shadow
  // survives the lift. After the dewarp so all three planes share geometry;
  // before graySeg so segmentation reads the lifted page.
  const edgeShadows: EdgeShadowResult = opts.edgeShadows !== false
    ? removeEdgeShadows(pa.gray, pa.pageW, pa.pageH, [pa.clean.data, pa.flat.data])
    : { lifted: 0 };
  mark('edgeShadows');

  // Word segmentation without Tesseract: build a rule-removed grayscale scratch page
  // (rules must be gone or a leftover line bridges letters/words into one blob), find
  // characters as connected components, and group them into words by gap clustering.
  // The rule baselines drive the lines. Pass B re-crops + cleans each word from the
  // ORIGINAL pa.gray below, so this scratch page never reaches the output.
  const graySeg = pa.gray.slice();
  passB.removeVRules(graySeg, pa.pageW, pa.pageH, pa.rules, p);
  mark('removeVRules:seg');
  // `ruleCls` is removeHRulesPage's own per-pixel verdict (1 erased rule,
  // 2 kept stroke) — the "what did the rule remover think" layer ocrlab shows.
  const ruleCls = removeHRulesPage(graySeg, pa.pageW, pa.pageH, pa.rules.rules);
  mark('removeHRulesPage');
  const ruleBaselines = pa.rules.rules.map((r) => {
    const s = r.y.slice().sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  });
  // UNRULED PAPER HAS TO GET ITS LINES FROM THE INK.
  //
  // `ccWordBoxes` drives its line assignment off these baselines and its
  // `assignLine` returns 0 for everything when the array is empty, so a page
  // with no printed rules put every word on one line and came back as a single
  // word box. See `inkBaselines`. This is only reached when the rule stage
  // genuinely found nothing, so it cannot change a ruled page's behaviour.
  let inkLines = 0;
  if (!ruleBaselines.length) {
    const fromInk = inkBaselines(graySeg, pa.pageW, pa.pageH, pa.lineHeight);
    ruleBaselines.push(...fromInk);
    inkLines = fromInk.length;
  }
  // Scrub residue the rule remover left behind BEFORE segmentation: at pixel
  // level a thin wide run inside a rule band is provably not writing, but once
  // the component pass bridges it into a neighbouring letter no later filter
  // can separate them (see eraseRuleResidue).
  // Both residue erasers get the classifier's verdicts: a pixel it KEPT (2)
  // must not be re-deleted as residue, or the green in ocrlab's verdict
  // overlay silently vanishes from the removed page — the reported bug.
  eraseRuleResidue(graySeg, pa.pageW, pa.pageH, ruleBaselines, pa.lineHeight, ruleCls);
  mark('eraseRuleResidue');
  // …and the residue that is already TOUCHING a letter, which the component
  // test above structurally cannot reach (see eraseWeldedRuleResidue). This is
  // the one that costs readings rather than adding phantom words: a streak
  // welding a word's last stroke to its comma makes them one component, so the
  // comma is never a separable mark and the recogniser has no punctuation to
  // find. Measured on the test photo: 457 leftover columns -> single digits,
  // longest surviving run 56 px -> 1 px.
  eraseWeldedRuleResidue(
    graySeg, pa.clean.data, pa.pageW, pa.pageH, pa.rules.rules, { ruleCls },
  );
  mark('eraseWeldedResidue');
  // A STROKE THAT CROSSES ITS RULE IS PUT BACK WHOLE. The remover erases the
  // rule's core rows in every column, and where a descender crosses the
  // baseline rule those rows are the descender's own ink — warehouse2's
  // `Parking` reached the segmenter as a g-bowl above row 546 and a loop
  // below it, two components, and the loop then read as `'s.` on its own. A
  // pixel the remover erased that has ink within reach both ABOVE and BELOW
  // it (a vertical bridge, one column of slack for a slanted stroke) is a
  // crossing, not print: it takes its original darkness back and is marked
  // kept so the erasers downstream leave it alone. A letter resting ON the
  // rule has ink above only and is untouched — this cannot regrow a rule.
  // Iterated so a three-row core reconnects from both edges inward.
  if (!(globalThis as { __noXRestore?: boolean }).__noXRestore) restoreRuleCrossings(graySeg, pa.gray, ruleCls, pa.pageW, pa.pageH);
  mark('restoreCrossings');
  // …and the FLAT STRIPS both of the above keep: the rule's shoulder smear
  // (10-20 px above the band, outside every eraser's reach) and locally
  // doubled rule segments the classifier keeps per-column. DETECTED here,
  // where darkness is still honest (segPage renders every char at one
  // level) — but NEVER auto-erased: this writer drags letter bottoms flat
  // along the rule and they overlap residue in every cheap feature (see
  // findFlatStripResidue). Candidates ride the result; the DECODE decides
  // (the editor's removeStripResidue).
  const flatStrips = findFlatStripResidue(graySeg, pa.pageW, pa.pageH, pa.rules.rules, pa.lineHeight, pa.gray);
  mark('flatStrips');
  // And the VERTICAL twin on the segmentation page (graySeg has just had its
  // vrules removed above, so the residue exists to erase). pa.gray gets the
  // same treatment AFTER its own removeVRules below — running it here erased
  // nothing, because the rule had not been removed from that buffer yet.
  const vr = pa.rules.vrules ?? [];
  // `symmetric` on grid paper: the band's asymmetry is an argument about a
  // MARGIN (nothing is written outboard of one), and every line of a lattice has
  // writing on both sides.
  const vrOpts = { symmetric: template.gridV };
  eraseVRuleResidue(graySeg, pa.pageW, pa.pageH, vr, pa.lineHeight, vrOpts);
  mark('eraseVRuleResidue:seg');
  // Ask the segmenter for its per-character CLEANED page as well: every
  // character re-thresholded with its own Otsu and re-rendered at one normalized
  // darkness on pure paper. That render is the page a LINE recognizer should
  // read — page-level geometry (none of Pass B's per-word leveling), specks and
  // bleed-through dropped, faint-but-accepted marks (i-dots) at full darkness,
  // and it is built BEFORE the word-level edge filter, so a wrongly-dropped
  // word's characters are still present for the decoder to recover.
  const segOut: CCWordOut = {
    clean: new Uint8Array(pa.pageW * pa.pageH),
    // The segmenter's own per-pixel line assignment (seam-aware: where
    // separateCrossLine cut a two-line weld, each side carries its line) —
    // componentOwnership consumes it as a prior for letter-sized components.
    lineMask: new Int16Array(pa.pageW * pa.pageH),
  };
  // A REBUILT grid holds the BLANK rules too (they had to exist for removal
  // and the dewarp), but segmentation must only see WRITTEN baselines: the
  // light-pen ink fragments per-character, a fragment binds to the nearest
  // baseline by its BOTTOM, and ascender tops then land on the blank rule
  // above — each written line's ink was split across three bands and the
  // decode read interleaved shreds ("imagessmoke", 48/52 word errors on a
  // page that segments cleanly). The ink's own row profile (on the DEWARPED
  // page — the rescue's pre-dewarp lines have moved) says which rules carry
  // writing.
  let segBaselines = ruleBaselines;
  if (rulesRebuilt && ruleBaselines.length >= 3) {
    // graySeg is rule-REMOVED, so a written rule's band holds real ink and a
    // blank rule's holds ~nothing: count dark pixels in the x-height band
    // above each baseline and keep the rules that carry writing. (An
    // inkBaselines match was tried first and dropped the SHORT lines — its
    // peak bar is page-relative and "be identified?" fell under it.)
    const paper3 = (() => {
      const samp: number[] = [];
      for (let i = 0; i < pa.pageW * pa.pageH; i += 499) samp.push(graySeg[i]);
      samp.sort((a, b) => a - b);
      return samp[Math.floor(samp.length * 0.85)] ?? 235;
    })();
    const darkT3 = paper3 - 30;
    // …and the band must be THIN: writing RESTS on its rule, so the letter
    // bottoms sit immediately above a written baseline, while the space just
    // above a blank mid-rule is the line-above's descender gap. A taller band
    // reaches the next line's ascenders and every blank rule reads "written".
    const bandH = Math.max(4, Math.round(pa.lineHeight * 0.35));
    const inkOf = (yb: number): number => {
      let n = 0;
      const y0 = Math.max(0, Math.round(yb) - bandH), y1 = Math.min(pa.pageH - 1, Math.round(yb) - 2);
      for (let y = y0; y <= y1; y++) {
        for (let x = 0; x < pa.pageW; x += 2) if (graySeg[y * pa.pageW + x] < darkT3) n++;
      }
      return n;
    };
    const counts = ruleBaselines.map(inkOf);
    if (typeof process !== 'undefined' && process.env?.HW_SEG_DEBUG) console.log('[seg-baselines] counts:', counts.map((c, i) => `${Math.round(ruleBaselines[i])}:${c}`).join(' '));
    // GREEDY, spacing-constrained: no ink-count bar separates a SHORT written
    // line from a blank rule that collects descenders — but the writing has a
    // known pitch, so take the heaviest rule, exclude its neighbours within
    // 0.7x that pitch, repeat. One baseline per written line, whichever phase
    // carries the letter bottoms; near-duplicate rules (a doubled seam snap)
    // resolve to the heavier twin for free.
    const order = counts.map((c, i) => i).sort((a, b) => counts[b] - counts[a]);
    const minSep = inkPitchSeg * 0.7;
    const chosen: number[] = [];
    for (const i of order) {
      if (counts[i] < 40) break;
      if (chosen.some((j) => Math.abs(ruleBaselines[j] - ruleBaselines[i]) < minSep)) continue;
      chosen.push(i);
    }
    if (chosen.length >= 3) segBaselines = chosen.map((i) => ruleBaselines[i]).sort((a, b) => a - b);
  }
  mark('segBaselines');
  // THE HAND-PAINTED OVERRIDE, applied last — after every automatic decision
  // about what this page's ink is, so it overrules all of them and none of
  // them can undo it. `applyInkPaint` does the destructive half on the page
  // itself (cut strokes whitened; added strokes given their pre-rule-removal
  // darkness back, minus anything `ruleCls` calls a printed rule), and
  // `ccWordBoxes` does the judgemental half (lower bar, no acceptance gate).
  if (opts.inkPaint && !inkPaintEmpty(opts.inkPaint)) {
    applyInkPaint(graySeg, pa.pageW, pa.pageH, opts.inkPaint, pa.gray, ruleCls);
    // …and the CUT half again on the page PASS B crops from. Without this
    // "not text" would hold for the decoder (which reads segPage) and not for
    // the rendered word (which is cropped from pa.gray), so the ink would keep
    // showing up in the editor after being cut. Passing no `origGray` makes
    // this call the cut alone — there is nothing to restore pa.gray FROM.
    applyInkPaint(pa.gray, pa.pageW, pa.pageH, opts.inkPaint);
  }
  const boxes = ccWordBoxes(graySeg, pa.pageW, pa.pageH, segBaselines, marginRightX, {
    wordGap: opts.wordGap ?? 35,
    gapSeparation: opts.gapSeparation ?? 0.38,
    inkPaint: opts.inkPaint?.mask,
    paintDark: opts.inkPaint?.darkish,
    marginLeftX,
  }, segOut);
  mark('ccWordBoxes');

  // Carry the segmenter's dot decision into the page Pass B actually crops from.
  // The segmenter knows a faint mark is an i/j dot because a letter body sits
  // under it; Pass B only sees intensity, and would drop it. Darkening the dot to
  // its own letter's darkness is what makes the two stages agree.
  if (segOut.faintDots?.length) {
    liftFaintDots(pa.gray, pa.pageW, pa.pageH, segOut.faintDots);
  }

  // Pass B — per-word normalization.
  // Remove vertical rules (the margin) from the page first — the per-word rule
  // removal only handles each word's horizontal baseline, so a vertical line
  // inside a crop would otherwise survive into the leftmost words.
  passB.removeVRules(pa.gray, pa.pageW, pa.pageH, pa.rules, p);
  // Scrub what THAT removal left behind: Pass B crops words from pa.gray, and
  // the margin-glyph classifier reads it too — a leftover vertical fragment in
  // the margin strip classifies as '1' and turns the first line into an
  // ordered list.
  eraseVRuleResidue(pa.gray, pa.pageW, pa.pageH, vr, pa.lineHeight, vrOpts);
  mark('removeVRules:page');
  // A REBUILT grid carries the BLANK rules too (removal and dewarp need
  // them), and its blank traces run right through the word boxes above each
  // written line — so nearest-rule baseline attachment must only see the
  // WRITTEN baselines, or half the words attach half a pitch high and the
  // decoder's frame collapses (measured: visually perfect traces and clean
  // bands decoded at 98% WER — hallucinated multi-line compounds — because
  // baselineY pointed at the blank rule).
  // Written-rules-only attachment was added while chasing the pair-trace
  // regression and did not move the measurement; the 25-error configuration
  // attaches against the FULL rule set. Kept behind a flag for the next
  // round rather than deleted.
  const attachWrittenOnly = false;
  const rulesForAttach = !attachWrittenOnly || segBaselines === ruleBaselines ? pa.rules : {
    ...pa.rules,
    rules: pa.rules.rules.filter((r) => {
      const t = r.y.slice().sort((a, b) => a - b);
      const m = t.length ? t[t.length >> 1] : 0;
      return segBaselines.some((y) => Math.abs(y - m) < Math.max(4, pa.lineHeight * 0.3));
    }),
  };
  const recs = passB.attachBaselines(pa.gray, pa.pageW, pa.pageH, rulesForAttach, boxes, p);
  mark('attachBaselines');
  // Foreign-line ink is scrubbed from the crops with the SAME component
  // ownership the decode bands use (clean/ccOwnership.ts — the logic extracted
  // from wordgpu/page.mjs linesFromRecs, which now imports it back from the
  // cleanlab bundle). On tight ruling a word's crop rectangle reaches over the
  // neighbouring lines and everything dark in it used to ride into the word's
  // displayed render. Ownership runs on SEGPAGE's components — the bridged
  // segmenter comps weld an accent to the line above's period, the per-char
  // clean render pulls them apart — and an UNCLAIMED/SHARED verdict keeps the
  // ink in every crop, the band cutter's own conservatism, so an unresolvable
  // mark is never amputated from the word it belongs to.
  const live = recs.filter((r) => r.status !== 'empty');
  const ownership = componentOwnership(live, segOut.clean!, pa.pageW, pa.pageH, opts.ownershipOverrides ?? null,
    segOut.lineMask && segOut.lineIds ? { mask: segOut.lineMask, lineIds: segOut.lineIds } : null);
  if (ownership) {
    // The decode's votes/bands keep reading the PRISTINE rectangle…
    for (const r of live) r.voteBox = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
    // …a word whose box still holds ANOTHER line's letters (a weld the
    // cross-line splitter could not shorten) gets its baseline attached again
    // on the ink it actually owns — the first attach saw the foreign letters
    // and could hand the word the line below's rule (see reattachOwned)…
    passB.reattachOwned(pa.gray, pa.pageW, pa.pageH, rulesForAttach, live, p, ownership);
    // …while the CROP grows to cover the word's own descenders: the segmenter
    // box stops where the cross-line splitter cut a g/y/p tail, and the old
    // rectangle chopped the loops mid-stroke (doppelgänger's g's).
    extendCropsToOwnedInk(ownership, live, pa.pageW, pa.pageH);
    // …and no mark may VANISH: a mark owned by a line whose word rectangles
    // still don't reach it is released to unclaimed, so the crops that do
    // cover it keep it (see releaseUncoveredMarks).
    releaseUncoveredMarks(ownership, live);
  }
  const cropMask = ownership ? ownershipMask(ownership, pa.pageW, pa.pageH) : undefined;
  mark('ownership');
  // The distance-graded rule-residue strips (removeHRulesPage's display mask)
  // are whitened from the CROPS the same way foreign-line ink is — the crops
  // are the editor's displayed ink, and the pen-pressure grooves under words
  // survive both the page-level remover (deliberately: erasing them
  // decode-side measured 8-11 photo words) and Pass B's own per-word rule
  // removal. The decode never reads a crop, so this is display-only.
  const stripPx = (ruleCls as unknown as { stripMask?: number[] }).stripMask;
  let stripCropMask: Uint8Array | undefined;
  if (stripPx?.length) {
    stripCropMask = new Uint8Array(pa.pageW * pa.pageH);
    for (const j of stripPx) stripCropMask[j] = 1;
  }
  passB.levelWords(pa.gray, pa.pageW, pa.pageH, pa.rules, recs, p, cropMask, undefined, stripCropMask);
  mark('levelWords');
  passB.removeRules(pa.rules, recs, p);
  mark('removeRules');
  passB.measureWords(recs, p);
  mark('measureWords');
  const targetXh = passB.normalizeHeights(recs, p);
  mark('normalizeHeights');
  // A fractional thickness goal becomes pixels only now that targetXh exists.
  if (opts.thicknessXh && opts.thicknessXh > 0 && targetXh > 0
    && opts.passB?.tnTarget === undefined) {
    p.tnTarget = opts.thicknessXh * targetXh;
  }
  // Two intermediate renders are skipped here: `rec.thick` for words with an
  // SDF (smoothWords re-renders them from `sdfAdj`) and `rec.bgclean`
  // (`cleanRenders` — no consumer reads it; a lab that wants it can call the
  // stage itself). `rec.smooth`, the shipped render, is untouched.
  passB.normalizeThickness(recs, p, false);
  passB.smoothWords(recs, p);
  mark('thickness+smooth');
  // CLOSED LOOP on the width the reader actually SEES. `tnTarget` positions
  // the SDF surface, but the smoothed render's edge ramp and darkness
  // normalization put the APPARENT stroke (the 50%-coverage width of
  // `rec.smooth`) ~2 px over it, near-constantly — measured: targets 2.96 and
  // 4.08 px both rendered at that offset. So the goal is stated in apparent
  // width, measured off the first render, and the target corrected once.
  if (opts.thicknessXh && opts.thicknessXh > 0 && targetXh > 0
    && opts.passB?.tnTarget === undefined) {
    const desired = opts.thicknessXh * targetXh;
    const apparent: number[] = [];
    for (const r of recs) {
      if (!r.smooth || r.status === 'empty') continue;
      const { width: w, height: h } = r.smooth;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = r.smooth.data[i * 4];
      const lv = passB.estimateLevels(gray);
      if (!lv) continue;
      const t = passB.runThickness(gray, w, h, passB.surfaceCut(lv, 0.5));
      if (t > 0) apparent.push(t);
    }
    apparent.sort((a, b) => a - b);
    const med = apparent.length ? apparent[apparent.length >> 1] : 0;
    if (med > 0 && Math.abs(desired - med) > 0.3) {
      p.tnTarget = Math.max(0.5, p.tnTarget + (desired - med));
      passB.normalizeThickness(recs, p, false);
      passB.smoothWords(recs, p);
    }
  }
  mark('thicknessLoop');

  dumpV2Debug(pa, boxes, recs, targetXh, opts.debug);

  // Margin glyphs → marks, matched to word lines by baseline. The strip's glyphs
  // sit left of the erased vrule band, so classifying from the same page gray is
  // fine.
  const lineY = new Map<number, number[]>();
  for (const r of recs) {
    if (!lineY.has(r.line)) lineY.set(r.line, []);
    lineY.get(r.line)!.push(r.baselineY);
  }
  const lines = [...lineY.entries()].map(([line, ys]) => ({
    line,
    baselineY: ys.reduce((a, b) => a + b, 0) / ys.length,
  }));
  const marginMarks = classifyMarginGlyphs(
    pa.gray, pa.pageW, pa.pageH, pa.rules, marginX, lines, pa.lineHeight,
    template.margin === 'right' ? 'right' : 'left',
  );
  mark('marginGlyphs');

  return {
    recs, marginMarks, targetXh, pass: pa, segPage: segOut.clean ?? graySeg,
    // What the dewarp did (always cheap); the per-pixel layers ride along so
    // ocrlab can show the stages — `pass.gray` is the dewarped page itself,
    // `ruleCls` the remover's verdicts, `ruleRemoved` the page with rules gone.
    dewarp,
    ...(dewarpSteps ? { dewarpSteps } : {}),
    ...(pairView ? { pairView } : {}),
    edgeShadows,
    quadCands,
    ruleCls,
    ruleRemoved: graySeg,
    // Dot-sized marks the segmenter refused. NOT in `segPage` and not part of
    // any character box — carried so a caller that has RECOGNIZED the page can
    // hand them to `restoreDots` for the characters that turned out to be i/j.
    // See restoreDots for why the decision is deferred rather than improved.
    dotCandidates: segOut.dotCandidates ?? [],
    // Flat strips that look like rule residue — deferred exactly like the
    // dots above: the decode's fitted character boxes decide (a strip a
    // predicted character claims is that character's ink; unclaimed = rule).
    flatStripCandidates: flatStrips,
    // The remover's distance-graded strip verdicts (trainImport GROOVE SHAVE,
    // display-only branch): page indices of thin flat at-the-rule pixels far
    // from any spilling stroke. NOT erased from segPage here — the decode
    // gate priced that at 8-11 photo words (broken letter feet match the
    // shape on light-ink pages) — the CALLER whitens them from the RENDER
    // after reading, the restoreDots pattern.
    stripResidue: ((ruleCls as unknown as { stripMask?: number[] }).stripMask ?? []),
    ...(cropMask ? { lineMask: cropMask } : {}),
    ...(ownership ? { ownership } : {}),
    ...(segOut.lineMask ? { segLineMask: segOut.lineMask, segLineIds: segOut.lineIds ?? [] } : {}),
    template: {
      template, auto: templateAuto, detected, rerun, vLatticeLines, dotsErased,
      inkBaselines: inkLines,
    },
    ...(timings ? { timings } : {}),
  };
}


/** See the call site in `cleanPage`: an erased rule pixel bridged by ink above
 *  and below is a stroke crossing the rule and is restored to its original
 *  darkness. `reach` rows of slack each way, one column sideways. */
export function restoreRuleCrossings(
  graySeg: Uint8Array,
  gray: Uint8Array,
  ruleCls: Uint8Array,
  W: number,
  H: number,
  inkThr = 168,
  reach = 3,
): number {
  let restored = 0;
  // The darkest pixel within one column of (x, y) — the stroke's own level
  // there, or 255 when there is none.
  const levelAt = (x: number, y: number): number => {
    if (y < 0 || y >= H) return 255;
    let best = 255;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      const v = graySeg[y * W + xx];
      if (v < best) best = v;
    }
    return best;
  };
  // A STROKE runs through: at least two consecutive ink rows on each side,
  // starting within `reach` of the pixel, at similar darkness to each other
  // and to the pixel's own original — a letter resting on the rule has no
  // run below it, and the rule's own shoulder smear is far lighter than the
  // stroke above it, so neither is bridged.
  const runFrom = (x: number, y: number, dir: number): { n: number; lvl: number } => {
    let n = 0, sum = 0;
    for (let d = 1; d <= reach + 1; d++) {
      const l = levelAt(x, y + d * dir);
      if (l < inkThr) { n++; sum += l; if (n >= 2) break; }
      else if (n) break;
    }
    return { n, lvl: n ? sum / n : 255 };
  };
  // Only rows that hold an erased rule pixel can restore one, and the passes
  // only ever turn 1 into 2 — so the rows are found once and the three passes
  // walk the bands rather than the page.
  const rowHasRule = new Uint8Array(H);
  for (let y = 1; y < H - 1; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) if (ruleCls[row + x] === 1) { rowHasRule[y] = 1; break; }
  }
  for (let pass = 0; pass < 3; pass++) {
    let n = 0;
    for (let y = 1; y < H - 1; y++) {
      if (!rowHasRule[y]) continue;
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (ruleCls[p] !== 1 || gray[p] >= inkThr + 30) continue;
        const up = runFrom(x, y, -1), down = runFrom(x, y, 1);
        if (up.n < 2 || down.n < 2) continue;
        if (Math.abs(up.lvl - down.lvl) > 45) continue;
        if (gray[p] > Math.max(up.lvl, down.lvl) + 30) continue;
        graySeg[p] = gray[p];
        ruleCls[p] = 2;
        n++;
        if ((globalThis as { __sepTrace?: unknown }).__sepTrace) {
          const g = globalThis as { __xrest?: number[] };
          (g.__xrest ??= []).push(p);
        }
      }
    }
    restored += n;
    if (!n) break;
  }
  if ((globalThis as { __sepTrace?: unknown }).__sepTrace && restored) {
    const pts = (globalThis as { __xrest?: number[] }).__xrest ?? [];
    const byRow = new Map<number, number[]>();
    for (const q of pts) { const yy = (q / W) | 0; const a = byRow.get(yy) ?? []; a.push(q % W); byRow.set(yy, a); }
    console.log(`[xrestore] restored ${restored} px: ` + [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([yy, xs]) => `y${yy}[${xs.sort((a, b) => a - b).join(',')}]`).join(' '));
  }
  return restored;
}
