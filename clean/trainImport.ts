// Training-page import: runs the EXACT SAME cleanup calls as the main editor's
// photo import (`importHandwritingV2` — Pass A dewarp/illumination/rule-removal/
// binarize → word segmentation → Pass B baseline / rule removal / height +
// thickness / smooth), just without sentence recognition. We inline the same
// orchestration (rather than calling importHandwritingV2) so we can also surface
// the INTERMEDIATE stages as overlay images for debugging — the trainer shows
// them so a writer can see where a bad line/rule came from.

import * as passA from './passA/params'
import * as passB from './passB/pipeline'
import * as passBParams from './passB/params'
import type { RuleTrace, VRuleTrace } from './types'
import { runPassA, type PassAResult } from './passADriver'
import { detectMarginLine } from './margin'
import { improveRules, detectGridRules, pruneTextCrossingRules, ccWordBoxes, type CCWordDebug } from './ccWordSeg'
import { debugLog } from './log'

const PAGE_ENABLE_IDX = passA.PARAMS.findIndex((p) => p.key === 'pageEnable')
const PAGE_MANUAL_IDX = passA.PARAMS.findIndex((p) => p.key === 'pageManual')
const RULE_THRESH_IDX = passA.PARAMS.findIndex((p) => p.key === 'ruleThresh')
// Lower than the shared default (0.2) so fainter horizontal rules are still
// traced — training pages often have light rules the default pass misses. This is
// the rule-ENERGY threshold (the slider); rule-tracing GEOMETRY (slope / band /
// pair skew / spacing) stays at the shared defaults — the original pair-tracing.
const TRAIN_RULE_THRESH = 0.1
// The "more rules" end of the slider goes below the param's declared min (0.05):
// the value is passed straight to the WASM with no clamp, so a lower relative
// threshold finds fainter rules. Give real headroom for pages that still miss.
const TRAIN_RULE_THRESH_MIN = 0.01

// ── rule-based dewarp (straighten the page off the found rules, re-detect) ────

function ruleMedianY(r: RuleTrace): number {
  const s = r.y.slice().sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}

/** Smooth a jagged/stepped rule trace (two box-blur passes) so it can drive a
 *  smooth warp instead of transferring its steps into the rectified image. */
function smoothY(y: number[], half: number): number[] {
  const W = y.length
  let a = y.slice()
  for (let pass = 0; pass < 2; pass++) {
    const b = new Array<number>(W)
    for (let x = 0; x < W; x++) {
      let s = 0
      let c = 0
      for (let d = -half; d <= half; d++) {
        const xx = x + d
        if (xx < 0 || xx >= W) continue
        s += a[xx]
        c++
      }
      b[x] = c ? s / c : a[x]
    }
    a = b
  }
  return a
}

// Small tie-break penalty for a vertical step (prefer flat where cost ties).
const SEAM_VMOVE_PENALTY = 40
// Columns per allowed ±1px step → hard slope cap. 10 ⇒ ≤ 2px per 20px.
const SEAM_COLS_PER_PX = 10
// Vertical (margin) seam: rows per allowed ±1px step → ≤ 2px horizontal / 10px vertical.
const VSEAM_ROWS_PER_PX = 5
// A margin seam must average at least this much darker than the strip's paper.
const VSEAM_MIN_DARK = 45

/**
 * Detect the vertical margin rule by a top→bottom slope-capped seam (the column
 * analogue of detectRulesBySeam): the seam may shift at most ±1px per block of
 * `VSEAM_ROWS_PER_PX` rows (≤ 2px horizontal / 10px vertical), so it follows a
 * slanted margin the whole way down instead of hitting a global drift limit.
 * Searched only in the left `xLimit` px; returned only if it reads as a real dark
 * line (mean ≥ VSEAM_MIN_DARK darker than the strip's paper). Null otherwise.
 */
function detectVerticalRule(gray: Uint8Array, W: number, H: number, xLimit: number): VRuleTrace | null {
  const B = VSEAM_ROWS_PER_PX
  const P = SEAM_VMOVE_PENALTY
  const xl = Math.max(2, Math.min(W, Math.round(xLimit)))
  const nR = Math.max(1, Math.ceil(H / B))
  const blockCost = (r: number, x: number): number => {
    const y0 = r * B
    const y1 = Math.min(H, y0 + B)
    let s = 0
    for (let y = y0; y < y1; y++) s += gray[y * W + x]
    return s
  }
  const prev = new Float64Array(xl)
  for (let x = 0; x < xl; x++) prev[x] = blockCost(0, x)
  const cur = new Float64Array(xl)
  const back = new Int16Array(nR * xl)
  for (let x = 0; x < xl; x++) back[x] = x
  for (let r = 1; r < nR; r++) {
    const row = r * xl
    for (let x = 0; x < xl; x++) {
      let bX = x
      let bV = prev[x]
      if (x > 0) {
        const v = prev[x - 1] + P
        if (v < bV) {
          bV = v
          bX = x - 1
        }
      }
      if (x < xl - 1) {
        const v = prev[x + 1] + P
        if (v < bV) {
          bV = v
          bX = x + 1
        }
      }
      cur[x] = blockCost(r, x) + bV
      back[row + x] = bX
    }
    prev.set(cur)
  }
  let bestX = -1
  let bestC = Infinity
  for (let x = 0; x < xl; x++) {
    if (prev[x] < bestC) {
      bestC = prev[x]
      bestX = x
    }
  }
  if (bestX < 0) return null

  // Paper level of the left strip, to judge whether the seam is a real line.
  const hist = new Int32Array(256)
  for (let y = 0; y < H; y++) for (let x = 0; x < xl; x++) hist[gray[y * W + x]]++
  let acc = 0
  const tot = H * xl
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= 0.8 * tot) {
      paper = v
      break
    }
  }
  if (bestC / H > paper - VSEAM_MIN_DARK) return null

  const nodeX = new Array<number>(nR)
  let x = bestX
  nodeX[nR - 1] = x
  for (let r = nR - 1; r >= 1; r--) {
    x = back[r * xl + x]
    nodeX[r - 1] = x
  }
  const xpath = new Array<number>(H)
  for (let y = 0; y < H; y++) {
    const r0 = Math.min(nR - 1, Math.floor(y / B))
    const r1 = Math.min(nR - 1, r0 + 1)
    const t = (y - r0 * B) / B
    xpath[y] = Math.round(nodeX[r0] * (1 - t) + nodeX[r1] * t)
  }

  // Recenter each row on the margin's dark-run midpoint and measure its width.
  // A run WIDER than `maxRun` is a horizontal rule (or text) crossing the margin,
  // not the margin itself — recentering on it would yank the seam across the page,
  // so those rows are left on the (vertical) interpolated path and not measured.
  const darkT = paper - 30
  const maxRun = 15
  const widths: number[] = []
  for (let y = 0; y < H; y++) {
    const cx = xpath[y]
    if (cx < 0 || cx >= W || gray[y * W + cx] >= darkT) continue
    let l = cx
    let rr = cx
    while (l > 0 && cx - (l - 1) <= maxRun && gray[y * W + l - 1] < darkT) l--
    while (rr < W - 1 && rr + 1 - cx <= maxRun && gray[y * W + rr + 1] < darkT) rr++
    const wdt = rr - l + 1
    if (wdt > maxRun) continue // crossing rule/text → keep vertical, don't measure
    xpath[y] = Math.round((l + rr) / 2)
    widths.push(wdt)
  }
  widths.sort((a, b) => a - b)
  const thickness = widths.length ? widths[widths.length >> 1] : 3
  return { thickness: Math.max(3, thickness + 2), x: xpath }
}

/**
 * Detect rules on an ALREADY-dewarped page by horizontal seam carving — NO pairs.
 * The page is divided into column BLOCKS of `SEAM_COLS_PER_PX`; a left→right DP
 * over the blocks may move the seam at most ±1px per block, which HARD-CAPS the
 * slope (≈2px per 20px) so a seam can't run diagonally into a neighbouring rule.
 * Cost = block darkness (dark rules are cheap); a small penalty breaks ties toward
 * flat. A seam whose MEAN cost is below `costThresh` is a rule; NMS by `minSpacing`.
 * Each kept seam is interpolated back to a per-column path (smooth, ≤ the cap).
 */
function detectRulesBySeam(
  gray: Uint8Array,
  W: number,
  H: number,
  costThresh: number,
  minSpacing: number,
): RuleTrace[] {
  const P = SEAM_VMOVE_PENALTY
  const S = SEAM_COLS_PER_PX
  const nC = Math.max(1, Math.ceil(W / S))
  // Block darkness at (block c, row y) = sum of gray over that block's columns.
  const blockCost = (c: number, y: number): number => {
    const x0 = c * S
    const x1 = Math.min(W, x0 + S)
    const row = y * W
    let s = 0
    for (let x = x0; x < x1; x++) s += gray[row + x]
    return s
  }

  const prev = new Float64Array(H)
  for (let y = 0; y < H; y++) prev[y] = blockCost(0, y)
  const cur = new Float64Array(H)
  const back = new Int16Array(nC * H) // back[c*H + y] = seam row in block c-1
  for (let y = 0; y < H; y++) back[y] = y
  for (let c = 1; c < nC; c++) {
    const col = c * H
    for (let y = 0; y < H; y++) {
      let bY = y
      let bV = prev[y]
      if (y > 0) {
        const v = prev[y - 1] + P
        if (v < bV) {
          bV = v
          bY = y - 1
        }
      }
      if (y < H - 1) {
        const v = prev[y + 1] + P
        if (v < bV) {
          bV = v
          bY = y + 1
        }
      }
      cur[y] = blockCost(c, y) + bV
      back[col + y] = bY
    }
    prev.set(cur)
  }

  // End rows whose MEAN cost (total darkness / width) is a local min below thresh.
  const mins: { y: number; c: number }[] = []
  for (let y = 0; y < H; y++) {
    const c = prev[y] / W
    if (c > costThresh) continue
    let isMin = true
    for (let d = -2; d <= 2; d++) {
      const yy = y + d
      if (yy < 0 || yy >= H) continue
      if (prev[yy] / W < c) {
        isMin = false
        break
      }
    }
    if (!isMin) continue
    const last = mins[mins.length - 1]
    if (last && y - last.y < minSpacing) {
      if (c < last.c) mins[mins.length - 1] = { y, c }
      continue
    }
    mins.push({ y, c })
  }

  // Backtrack node rows, then interpolate to a smooth per-column path (slope ≤ cap).
  return mins.map((m) => {
    const nodeY = new Array<number>(nC)
    let y = m.y
    nodeY[nC - 1] = y
    for (let c = nC - 1; c >= 1; c--) {
      y = back[c * H + y]
      nodeY[c - 1] = y
    }
    const path = new Array<number>(W)
    for (let x = 0; x < W; x++) {
      const c0 = Math.min(nC - 1, Math.floor(x / S))
      const c1 = Math.min(nC - 1, c0 + 1)
      const t = (x - c0 * S) / S
      path[x] = Math.round(nodeY[c0] * (1 - t) + nodeY[c1] * t)
    }
    return { thickness: 2, y: path }
  })
}

/**
 * Rectify the flattened page by warping each found rule to a horizontal line at
 * its own median height (a column-wise vertical remap, linearly interpolated
 * between rules and extrapolated past the ends). Rules the tracer missed sit on
 * the same page warp as their neighbours, so they come out horizontal too — a
 * second detection pass on this image finds them. Natural spacing is preserved
 * (each rule targets its own median), so distortion is just the de-slant/de-curl.
 */
function dewarpByRules(flat: ImageData, rules: RuleTrace[]): ImageData {
  const W = flat.width
  const H = flat.height
  const src = flat.data
  const info = rules.map((r) => ({ r, my: ruleMedianY(r) })).sort((a, b) => a.my - b.my)
  const n = info.length
  const dst = info.map((it) => it.my)
  const out = new ImageData(W, H)
  const dd = out.data
  const yAtCol = (i: number, x: number): number => {
    const y = info[i].r.y
    return y[Math.min(Math.max(0, x), y.length - 1)]
  }
  for (let x = 0; x < W; x++) {
    const sc = new Float64Array(n)
    for (let i = 0; i < n; i++) sc[i] = yAtCol(i, x)
    let j = 0
    for (let yOut = 0; yOut < H; yOut++) {
      while (j < n - 2 && dst[j + 1] < yOut) j++
      const denom = dst[j + 1] - dst[j]
      const yIn = denom !== 0 ? sc[j] + ((yOut - dst[j]) / denom) * (sc[j + 1] - sc[j]) : sc[j]
      const oi = (yOut * W + x) * 4
      const y0 = Math.floor(yIn)
      if (y0 < -1 || y0 >= H) {
        dd[oi] = dd[oi + 1] = dd[oi + 2] = 255
        dd[oi + 3] = 255
        continue
      }
      const fy = yIn - y0
      const ya = Math.min(Math.max(y0, 0), H - 1)
      const yb = Math.min(Math.max(y0 + 1, 0), H - 1)
      const ia = (ya * W + x) * 4
      const ib = (yb * W + x) * 4
      dd[oi] = Math.round(src[ia] * (1 - fy) + src[ib] * fy)
      dd[oi + 1] = Math.round(src[ia + 1] * (1 - fy) + src[ib + 1] * fy)
      dd[oi + 2] = Math.round(src[ia + 2] * (1 - fy) + src[ib + 2] * fy)
      dd[oi + 3] = 255
    }
  }
  return out
}

/** One connected ink blob (a whole glyph, or a piece of one like an i-dot / t-cross),
 *  masked onto white so neighbouring characters never bleed into the crop. */
export interface TrainComponent {
  /** Masked crop, dark ink on white paper. Size = the component's page bbox. */
  gray: ImageData
  /** Page bbox (used to order + merge parts into whole characters). */
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface TrainLine {
  index: number
  /** Every ink blob on the line, left-to-right. The UI merges overlapping / close
   *  blobs into whole characters (so an i-dot rides with its stem). */
  components: TrainComponent[]
  /** Page-y of the line's baseline. */
  baselineY: number
}

export interface TrainDebug {
  pageW: number
  pageH: number
  /** Flat page + traced rules (horizontal red, vertical blue). */
  flatRules: string
  /** Clean page + segmenter word boxes (green), labeled by line. */
  cleanBoxes: string
  /** Clean page + each word's baseline, colored per line group. */
  baselines: string
  /** Clean page + each word's expanded CROP rect, colored per line group — a tall
   *  crop that swallowed the rule/next line shows up immediately here. */
  crops: string
  /** removeRules mask over each leveled crop: RED = erased rule band, BLACK =
   *  protected text kept, gray = untouched. */
  ruleMask: string
  /** Per-word CLEAN crop (rule removed + inpainted) pasted at page position. */
  cleaned: string
  /** The composited line strips as GRAYSCALE, exactly as they enter the two
   *  thresholds (i.e. before binarization) — stacked into one image. */
  preThreshold: string
  /** The rule-based dewarp result (flat page rectified off the found rules), or
   *  '' if none was produced. */
  dewarp: string
  /** The rectified page with the SECOND pass's rules drawn on it (what re-detection
   *  found on the dewarped image), or ''. */
  dewarpRules: string
  /** One-line explanation of what the dewarp step did. */
  dewarpNote: string
  stats: {
    rules: number
    vrules: number
    segLines: number
    boxes: number
    recs: number
    withSmooth: number
    lineGroups: number
    byStatus: Record<string, number>
  }
}

export interface TrainImportResult {
  lines: TrainLine[]
  /** Median line-strip height (px) — a sensible default for the gap slider. */
  unitPx: number
  debug: TrainDebug
}

export interface TrainImportOptions {
  /** Skip page detection/dewarp — use the full frame as-is. */
  skipDewarp?: boolean
  /** TL,TR,BR,BL (gray coords) to use instead of auto-detection. Ignored when
   *  skipDewarp is set. Same contract as the editor's ImportPreviewModal. */
  manualQuad?: number[]
  /** Pass A rule-detection threshold (lower = more/fainter rules). Defaults to
   *  TRAIN_RULE_THRESH. Range from the shared param def (0.05–0.9). */
  ruleThresh?: number
  /** Seam detector (on the dewarped page): max mean seam cost to count as a rule
   *  (higher = include fainter seams). Mean gray 0–255. */
  seamCost?: number
  /** Seam detector: minimum vertical spacing (px) between detected rules. */
  seamMinSpacing?: number
  /** Pass B blob detection: minimum darkness BELOW paper for a pixel to count as
   *  ink at all (connectivity + the exported mask). Defaults to INK_DARK_DEF. */
  inkDark?: number
  /** Pass B blob acceptance: minimum darkness STRENGTH = Σ ((paper−gray)/255)^power
   *  over the blob's ink pixels. Squaring (power 2) means a few really dark pixels
   *  count for a lot while many faint ones don't. Defaults to MIN_STRENGTH_DEF. */
  minStrength?: number
  /** Exponent in the strength sum (1 = plain darkness sum, 2 = sum of squares —
   *  emphasises dark pixels). Defaults to DARK_POWER_DEF. */
  darkPower?: number
  /** Pass B: bridge ink gaps up to this many px (morphological close) so a stroke
   *  broken by a tiny gap stays ONE blob. Defaults to BRIDGE_DEF. */
  bridgePx?: number
  /** Horizontal rule removal: a band pixel this much DARKER than the rule's own
   *  (running-median) colour is kept as stroke ink rather than erased. Lower keeps
   *  more faint text lying on the rule; too low starts keeping the rule itself.
   *  Defaults to RM_KEEP_DELTA_DEF. */
  ruleKeepDelta?: number
}

const SEAM_COST_DEF = 205
const SEAM_SPACING_DEF = 15
const INK_DARK_DEF = 50
const MIN_STRENGTH_DEF = 8
const DARK_POWER_DEF = 1.3
const BRIDGE_DEF = 3

/** Default trainer rule threshold + its adjustable range. The min is extended
 *  below the shared param def so the slider can push rule detection further. */
export function ruleThreshInfo(): { def: number; min: number; max: number } {
  const d = passA.PARAMS.find((p) => p.key === 'ruleThresh')
  return { def: TRAIN_RULE_THRESH, min: TRAIN_RULE_THRESH_MIN, max: d?.max ?? 0.9 }
}

/** Defaults + ranges for the seam-detector sliders (cost threshold, min spacing). */
export function seamInfo(): { cost: { def: number; min: number; max: number }; spacing: { def: number; min: number; max: number } } {
  return {
    cost: { def: SEAM_COST_DEF, min: 120, max: 250 },
    spacing: { def: SEAM_SPACING_DEF, min: 4, max: 120 },
  }
}

/** Defaults + ranges for the blob-detection sliders. */
export function blobInfo(): {
  dark: { def: number; min: number; max: number }
  strength: { def: number; min: number; max: number }
  power: { def: number; min: number; max: number }
  bridge: { def: number; min: number; max: number }
} {
  return {
    dark: { def: INK_DARK_DEF, min: 8, max: 160 },
    strength: { def: MIN_STRENGTH_DEF, min: 0.5, max: 80 },
    power: { def: DARK_POWER_DEF, min: 1, max: 3 },
    bridge: { def: BRIDGE_DEF, min: 0, max: 5 },
  }
}

/** Default + range for the horizontal-rule keep-delta slider. */
export function ruleRemoveInfo(): { def: number; min: number; max: number } {
  return { def: RM_KEEP_DELTA_DEF, min: 10, max: 90 }
}

/** Separable morphological dilation of a binary mask by `r` px (Chebyshev) —
 *  used to bridge tiny gaps so a broken stroke stays one connected blob. */
function dilateMask(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return src
  const tmp = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const row = y * W
    let n = 0
    for (let x = 0; x <= r && x < W; x++) n += src[row + x]
    for (let x = 0; x < W; x++) {
      if (x > 0) {
        const add = x + r
        const del = x - r - 1
        if (add < W) n += src[row + add]
        if (del >= 0) n -= src[row + del]
      }
      tmp[row + x] = n > 0 ? 1 : 0
    }
  }
  // vertical pass in row order, one running count per column (see the twin
  // in ccWordSeg.ts)
  const out = new Uint8Array(W * H)
  const n = new Int32Array(W)
  for (let y = 0; y <= r && y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) n[x] += tmp[row + x]
  }
  for (let y = 0; y < H; y++) {
    if (y > 0) {
      const add = y + r
      const del = y - r - 1
      if (add < H) { const row = add * W; for (let x = 0; x < W; x++) n[x] += tmp[row + x] }
      if (del >= 0) { const row = del * W; for (let x = 0; x < W; x++) n[x] -= tmp[row + x] }
    }
    const row = y * W
    for (let x = 0; x < W; x++) out[row + x] = n[x] > 0 ? 1 : 0
  }
  return out
}

// ── overlay helpers ─────────────────────────────────────────────────────────

function canvasOf(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c
}

const lineColor = (line: number) => `hsl(${(line * 67) % 360} 85% 45%)`

function rulesOverlay(pa: PassAResult): string {
  const c = canvasOf(pa.flat)
  const ctx = c.getContext('2d')!
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(255,0,0,0.85)'
  for (const r of pa.rules.rules) {
    ctx.beginPath()
    for (let x = 0; x < r.y.length; x++) (x ? ctx.lineTo(x, r.y[x]) : ctx.moveTo(x, r.y[x]))
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(0,80,255,0.85)'
  for (const v of pa.rules.vrules ?? []) {
    ctx.beginPath()
    for (let y = 0; y < v.x.length; y++) (y ? ctx.lineTo(v.x[y], y) : ctx.moveTo(v.x[y], y))
    ctx.stroke()
  }
  return c.toDataURL('image/png')
}


/** Composite a line's masked component crops back at their page-relative offsets,
 *  into one grayscale strip — used only for the debug stack. */
function lineToStrip(line: TrainLine): ImageData {
  const comps = line.components
  if (!comps.length) return new ImageData(1, 1)
  const minX = Math.min(...comps.map((c) => c.x0))
  const minY = Math.min(...comps.map((c) => c.y0))
  const maxX = Math.max(...comps.map((c) => c.x1))
  const maxY = Math.max(...comps.map((c) => c.y1))
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const out = new ImageData(w, h)
  out.data.fill(255)
  for (const c of comps) {
    const cw = c.gray.width
    const ch = c.gray.height
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const si = (yy * cw + xx) * 4
        if (c.gray.data[si + 3] === 0) continue
        const g = c.gray.data[si]
        if (g >= 255) continue // white padding, skip
        const ox = c.x0 - minX + xx
        const oy = c.y0 - minY + yy
        const o = (oy * w + ox) * 4
        out.data[o] = out.data[o + 1] = out.data[o + 2] = g
        out.data[o + 3] = 255
      }
    }
  }
  return out
}

/** Stack line strips vertically into one image (light-gray gaps) for a debug view. */
function stackStrips(strips: ImageData[]): string {
  if (!strips.length) {
    const e = document.createElement('canvas')
    e.width = e.height = 1
    return e.toDataURL('image/png')
  }
  const gap = 8
  const w = Math.max(...strips.map((s) => s.width))
  const h = strips.reduce((sum, s) => sum + s.height, 0) + gap * (strips.length - 1)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#e5e5e5'
  ctx.fillRect(0, 0, w, h)
  let y = 0
  for (const s of strips) {
    const tmp = document.createElement('canvas')
    tmp.width = s.width
    tmp.height = s.height
    tmp.getContext('2d')!.putImageData(s, 0, 0)
    ctx.drawImage(tmp, 0, y)
    y += s.height + gap
  }
  return c.toDataURL('image/png')
}

// ── main ─────────────────────────────────────────────────────────────────────

/** Cached Pass A + segmentation (the slow WASM part). Pass B can be
 *  re-run on this repeatedly with different params without redoing Pass A. */
export interface TrainPassA {
  pa: PassAResult
  /** X to the right of which real writing lives (left of the margin excluded). */
  marginRightX: number
  dewarp: string
  dewarpRules: string
  dewarpNote: string
}

/** Run Pass A (dewarp / clean / rules) + word segmentation. SLOW — cache it. */
export async function runTrainingPassA(
  img: HTMLImageElement,
  opts?: TrainImportOptions,
): Promise<TrainPassA> {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const cnv = document.createElement('canvas')
  cnv.width = w
  cnv.height = h
  const cctx = cnv.getContext('2d')!
  cctx.drawImage(img, 0, 0)
  const rgba = cctx.getImageData(0, 0, w, h).data

  // Only the rule-ENERGY threshold is overridden (the slider). Rule-tracing
  // geometry (slope / band / pair skew / spacing) stays at the shared defaults —
  // the original pair-tracing — then layer on the preview's dewarp choice.
  const paParams = passA.defaultParams()
  if (RULE_THRESH_IDX >= 0) paParams[RULE_THRESH_IDX] = opts?.ruleThresh ?? TRAIN_RULE_THRESH
  let manualQuad: number[] | undefined
  if (opts?.skipDewarp) {
    paParams[PAGE_ENABLE_IDX] = 0
  } else if (opts?.manualQuad) {
    paParams[PAGE_MANUAL_IDX] = 1
    manualQuad = opts.manualQuad
  }
  let pa = await runPassA(rgba, w, h, paParams, manualQuad)

  // Rule-based dewarp: rectify the page off the found rules so the previously-
  // missed (now-horizontal) rules can be re-detected. The raw traces are stepped,
  // so SMOOTH each one first (else the steps warp into the image). Always render
  // the rectified image + the rules the second pass finds on it; adopt the second
  // pass only if it finds AT LEAST as many rules (no regression).
  let dewarp = ''
  let dewarpRules = ''
  let dewarpNote =
    pa.rules.rules.length < 2 ? `skipped — only ${pa.rules.rules.length} rule(s) to rectify from` : ''
  if (pa.rules.rules.length >= 2) {
    const before = pa.rules.rules.length
    const bend = Math.round(Math.max(...pa.rules.rules.map((r) => Math.max(...r.y) - Math.min(...r.y))))
    const half = Math.min(60, Math.max(15, Math.round(pa.pageW / 50)))
    const smoothed = pa.rules.rules.map((r) => ({ thickness: r.thickness, y: smoothY(r.y, half) }))
    const warped = dewarpByRules(pa.flat, smoothed)
    dewarp = canvasOf(warped).toDataURL('image/png')

    const p2 = passA.defaultParams()
    if (RULE_THRESH_IDX >= 0) p2[RULE_THRESH_IDX] = opts?.ruleThresh ?? TRAIN_RULE_THRESH
    p2[PAGE_ENABLE_IDX] = 0 // input is already flattened + rectified
    const pa2 = await runPassA(warped.data, warped.width, warped.height, p2)
    // The page is now flat, so detect rules by horizontal seam carving (no pairs;
    // vertical movement heavily penalized) instead of the WASM pair-tracer.
    const seamRules = detectRulesBySeam(
      pa2.gray,
      pa2.pageW,
      pa2.pageH,
      opts?.seamCost ?? SEAM_COST_DEF,
      opts?.seamMinSpacing ?? SEAM_SPACING_DEF,
    )
    if (seamRules.length) pa2.rules.rules = seamRules
    // Vertical margin rule: slope-capped vertical seam in the left strip.
    const vrule = detectVerticalRule(pa2.gray, pa2.pageW, pa2.pageH, pa2.pageW * 0.35)
    if (vrule) pa2.rules.vrules = [vrule]
    dewarpRules = rulesOverlay(pa2) // seam-detected rules on the dewarped image
    const after = pa2.rules.rules.length
    if (after >= before) {
      pa = pa2
      dewarpNote = `rectified (smoothed, bend ${bend}px) + seam-detected ${after} rules (WASM 1st pass: ${before})`
    } else {
      dewarpNote = `rectified (bend ${bend}px) but kept original: seam found ${after} < ${before}`
    }
  }

  const { marginRightX } = detectMarginLine(pa)
  return { pa, marginRightX, dewarp, dewarpRules, dewarpNote }
}

// ── page-level rule removal + direct line strips ─────────────────────────────

const RULE_REMOVE_INK = 165
const RULE_REMOVE_EXTEND = 3

// Horizontal rule removal (page-level port of Pass B's `removeRules`). The old
// version made an all-or-nothing decision PER COLUMN — it kept a column's whole
// band only when ink sat BOTH directly above AND below it — so it erased every
// letter resting ON the baseline (ink above, nothing below) and every stroke that
// crossed the rule at an angle. Instead we now decide PER PIXEL against the rule's
// own expected colour: a band pixel that is meaningfully DARKER than the running
// median along the rule (the local rule/paper colour) is stroke ink and is kept;
// only pixels at the rule's own colour are erased.
const RM_WINDOW = 80 // running-median half-window (px) along the rule → expected colour
const RM_KEEP_DELTA_DEF = 50 // a band pixel this much darker than expected = stroke ink
const RM_EXTEND = 3 // vertical dark run reaching this far beyond the band = crossing/resting stroke
const RM_GROW = 60 // connectivity-rescue reach (px) for faint stroke pixels lying along the rule
const RM_STRIP_NEAR = 2 // columns beside a spilling stroke where a strip keeps its contact pixels
const RM_STRIP_FAR = 4 // beyond this distance from any stroke, a qualifying strip is removed whole
const RM_STRIP_GAP = 18 // two strokes closer than this bridge as one (a bowl bottom, a base bar)
const RM_BRIDGE = 2 // rescue connectivity radius (px), bridges small light gaps in a stroke
// Dot-on-the-rule rescue (see the block near the end of removeHRulesPage). Set
// for PRECISION: a period is unmistakably darker than the print it lands on, so
// the darkness bar is a multiple of the ordinary keep delta, not a shading of it.
const RD_DELTA_MULT = 2 // × keepDelta: how much darker than the rule's local median
const RD_MAX_FRAC = 0.3 // × rule spacing: size ceiling for "a dot", both dimensions
const RD_MAX_ASPECT = 2.5 // roughly round — a streak along the rule is not a dot
const RD_MIN_FILL = 0.5 // solid, not a wisp: filled fraction of the bounding box
// Seed offsets around a trace, nearest first (the locate walks stop at the
// first dark pixel). Module constants: these used to be array literals inside
// per-column loops, one allocation per column per rule.
const SEED_DY = [0, -1, 1, -2, 2, -3, 3, -4, 4]
const SEED_DY_WIDE = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]

/** Running median of a single grayscale row over a ±winhw window (histogram slide),
 *  written into `out`. The rule's local colour at each column, robust to the stroke
 *  pixels sitting on it. Same technique as pipeline.ts `runningMedian`. */
/** Sliding-window median down a row, in constant time per pixel.
 *
 *  The histogram was already incremental; the MEDIAN SEARCH was not — it
 *  restarted the cumulative walk at bin 0 for every pixel, so the filter cost
 *  W x 256 per row. The median moves by a bin or two between neighbouring
 *  windows, so carrying it (with the count strictly below it) makes the walk
 *  O(1) amortized. Same answer by construction: both pick the smallest v whose
 *  cumulative count exceeds half the window. */
function rowRunningMedian(gray: Uint8Array, W: number, y: number, winhw: number, out: Uint8Array): void {
  const hist = new Uint16Array(256)
  let count = 0
  for (let x = 0; x <= winhw && x < W; x++) {
    hist[gray[y * W + x]]++
    count++
  }
  let med = 0, below = 0   // below = number of samples strictly under `med`
  for (let x = 0; x < W; x++) {
    if (x > 0) {
      const add = x + winhw
      const del = x - winhw - 1
      if (add < W) {
        const v = gray[y * W + add]
        hist[v]++
        count++
        if (v < med) below++
      }
      if (del >= 0) {
        const v = gray[y * W + del]
        hist[v]--
        count--
        if (v < med) below--
      }
    }
    // target = the smallest v with cumulative count > count/2
    const k = (count >> 1) + 1
    while (below + hist[med] < k) { below += hist[med]; med++ }
    while (below >= k) { med--; below -= hist[med] }
    out[x] = med
  }
}

/**
 * Erase horizontal rule bands across the whole page, keeping any pixel that is
 * part of a stroke — one that crosses the rule, rests on it, or runs along it.
 *
 * Per band pixel: `outlier` = darker than the rule's expected colour by `keepDelta`.
 * An outlier is KEPT when its vertical dark run extends past the band on EITHER
 * side (a crossing stroke continues; a letter resting on the baseline has its body
 * above) — this is the fix for text over the rule. A faint outlier that fails that
 * test is still rescued when it connects (within `RM_GROW` px, across `RM_BRIDGE`
 * gaps) to kept ink — so a stroke curving ALONG the rule survives. Everything else
 * in the band is the rule and gets filled from the paper just outside it.
 *
 * Returns a page-level classification mask (0 = untouched, 1 = erased rule,
 * 2 = kept stroke) for the debug overlay. Mutates `gray` in place.
 */
export function removeHRulesPage(
  gray: Uint8Array,
  W: number,
  H: number,
  rules: RuleTrace[],
  keepDelta = RM_KEEP_DELTA_DEF,
): Uint8Array {
  const cls = new Uint8Array(W * H) // 0 untouched · 1 erase (rule) · 2 keep (stroke)
  if (!rules.length) return cls

  // Page paper level → an ink threshold used only for the run/connectivity tests
  // ("is this neighbouring pixel part of a stroke?"). Built from the ORIGINAL gray
  // so later fills don't shift it; each rule's band is far from the next, so mutating
  // one band never affects another's test meaningfully.
  const hist = new Int32Array(256)
  for (let i = 0; i < W * H; i++) hist[gray[i]]++
  let acc = 0
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= 0.85 * W * H) {
      paper = v
      break
    }
  }
  const inkT = Math.max(0, paper - 45)
  const ink = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (gray[i] < inkT) ink[i] = 1

  // keepDelta is a RATE of the page's own ink-to-paper contrast, capped at the
  // caller's absolute value. On dark ink (contrast 150+) this is exactly the
  // old constant, byte for byte. On light-grey ink the absolute 50 sat NEAR the
  // whole contrast: a stroke pixel could not be 50 darker than the local median
  // and every run along a rule was classified rule and erased — the chewed
  // s-bottoms. inkLevel is the 0.5th percentile: the page's confidently-ink
  // darkness, cheap and stable.
  let cum = 0
  let inkLevel = 0
  for (let v = 0; v < 256; v++) {
    cum += hist[v]
    if (cum >= 0.005 * W * H) { inkLevel = v; break }
  }
  const kd = Math.max(12, Math.min(keepDelta, Math.round(0.55 * (paper - inkLevel))))
  const rescueDelta = Math.max(6, Math.round(kd * 0.55)) // gentler Δ for rescued pixels
  const med = new Uint8Array(W)
  // the rule's expected colour per band pixel — a running median of grays,
  // so a byte holds it exactly (it was a Float32Array: five times the memory
  // to zero, walk and miss cache on, for integer values)
  const expected = new Uint8Array(W * H)
  // COLOUR WAS TRIED HERE AND MEASURED WORSE, TWICE (Aug 17 2026) — recorded so
  // it is not re-tried. Rule-vs-ink colour medians from the flattened RGBA,
  // used (a) to keep decisively ink-coloured band pixels and (b) to erase
  // decisively rule-coloured pixels in a bend-escape zone: photo corpus
  // 76 -> 98 errors, and with (a) demoted to a rescue precondition 76 -> 91.
  // Two failure modes: JPEG chroma blends at stroke edges near the rule read
  // as "ink" and survive as isolated crumbs (false commas), and pages WRITTEN
  // IN BLUE collide with blue rules — page C's periods sat in the escape zone,
  // matched the rule's colour, and were deleted outright. Colour cannot
  // arbitrate print-vs-ink when both are the same substance, and this corpus
  // contains both regimes.
  // The stroke-run logic below (strokeStamp) is the intensity-only fix for the
  // same two complaints.
  const strokeStamp = new Uint16Array(W * H)   // stamps count rules: a few dozen
  let stamp = 0

  // Per-rule MEASURED print thickness. The tracer's `thickness` is a stamp —
  // the pair tracer writes a constant 2 — and every window here (band, core,
  // reach, and the strip tests below) is sized from it, so a rule whose real
  // print+blur runs 4-5px gets undersized windows and leaves residue: the
  // "certain rules are harder to remove" complaint, located. Measure instead:
  // the median located-run height over columns where the run is clean (≤ 6px
  // — a letter contact welds taller and is excluded), never SMALLER than the
  // stamp.
  const tMeasured = new Map<RuleTrace, number>()
  // ROWS WHERE ANYTHING CAN HAPPEN. Every pixel this function condemns or
  // shaves lies within a few px of a trace: the band is +-hb (<= 8), the
  // located-run and strip erases reach +-6 past the trace plus a run no
  // taller than t+2 (<= 14), the carve stays inside +-(t+3) (<= 15) and the
  // shave window is +-(hb+6) (<= 11). The three page-wide scans below (the
  // dot rescue, the shave flood, the fill) therefore walk only rows within
  // ROW_REACH of some trace — a superset of everything they can find, so the
  // result is the same and the work scales with the rules, not the page.
  // EVERY PIXEL THIS FUNCTION ERASES IS LISTED AS IT IS ERASED (`erased`),
  // so the two passes that visit "each erased pixel" — the dot rescue and the
  // fill — walk that list rather than the page. On ruled paper the bands
  // between them cover most rows, so a row filter would not have helped; the
  // list is a few hundred thousand entries against a couple of million
  // pixels. A pixel may be listed twice (a carve over a band): the rescue
  // floods a component once whichever entry finds it, and the fill reads
  // only never-written pixels, so a repeat computes the same value.
  const erased: number[] = []
  // measured at a gentler bar than inkT: a FAINT rule (the kind that leaves
  // residue) never clears paper-45 and would measure nothing, silently
  // keeping the stamp — paper-30 reads faint print while staying above
  // paper texture
  const measT = paper - 30
  // …and the rule's own PRINT DARKNESS (median clean-run minimum), the
  // reference the displaced-run erase below judges against: a run at the
  // rule's own level is print wherever it sits; a decisively darker run is
  // the writer's ink. 255 = unmeasured, which disables that erase.
  const dkMeasured = new Map<RuleTrace, number>()
  for (const r of rules) {
    const heights: number[] = []
    const darks: number[] = []
    for (let x = 0; x < W; x += 3) {
      const ry = Math.round(r.y[Math.min(x, r.y.length - 1)])
      let seed = -1
      for (let k = 0; k < SEED_DY.length; k++) {
        const y = ry + SEED_DY[k]
        if (y >= 1 && y < H - 1 && gray[y * W + x] < measT) { seed = y; break }
      }
      if (seed < 0) continue
      let a = seed
      let b = seed
      while (a > 0 && gray[(a - 1) * W + x] < measT) a--
      while (b < H - 1 && gray[(b + 1) * W + x] < measT) b++
      const h = b - a + 1
      if (h <= 6) {
        heights.push(h)
        let mn = 255
        for (let y = a; y <= b; y++) mn = Math.min(mn, gray[y * W + x])
        darks.push(mn)
      }
    }
    heights.sort((p, q) => p - q)
    darks.sort((p, q) => p - q)
    const med = heights.length >= 20 ? heights[heights.length >> 1] : 0
    tMeasured.set(r, Math.min(6, Math.max(Math.min(r.thickness, 12), med)))
    dkMeasured.set(r, darks.length >= 20 ? darks[darks.length >> 1] : 255)
  }

  for (const r of rules) {
    const t = tMeasured.get(r) ?? Math.min(r.thickness, 12)
    const hb = Math.max(1, t >> 1) + 2
    const reach = hb * 2 + RM_EXTEND + t
    const ryArr = new Int32Array(W)
    let yMin = H
    let yMax = -1
    for (let x = 0; x < W; x++) {
      const ry = Math.round(r.y[Math.min(x, r.y.length - 1)])
      ryArr[x] = ry
      if (ry - hb < yMin) yMin = ry - hb
      if (ry + hb > yMax) yMax = ry + hb
    }
    yMin = Math.max(0, yMin)
    yMax = Math.min(H - 1, yMax)
    if (yMax < yMin) continue

    // THE RULE IS A LOCATED RUN, NOT A BAND. Per column, the printed rule is
    // one contiguous dark run of ~thickness px whose centre tracks the trace;
    // everything the old per-pixel tests erased beyond that run is a stroke:
    //   - a separate dark run in the band (an s-bottom hugging the rule with a
    //     1px gap) has no vertical run and barely outlies the in-band median,
    //     so it was erased — the chew;
    //   - the located run's EXCESS beyond the expected thickness (a stroke
    //     lying ON the rule) is the writer's ink thickening the print;
    //   - a column with NO run overlapping the trace has no rule to remove,
    //     and its band ink is all stroke.
    // `strokeStamp` marks those keeps for the classify pass. The located run
    // is also followed a few px past the band edge when the rule bends off
    // the trace (its core is erased there too), which is what the old fixed
    // band structurally could not reach.
    stamp++
    // Stamp/locate at the page's INK gate, not near-paper: page E's
    // bleed-through ghosts sit at paper-15..paper-40 and a permissive
    // threshold kept them as "stroke" all along the bands — the old band
    // erase had been deleting them silently. Real ink clears paper-45 easily.
    const inkT2 = inkT
    const coreUp = (t >> 1) + 1, coreDn = ((t + 1) >> 1) + 1

    // A DISPLACED CLEAN RUN IS THE RULE, NOT A STROKE ON IT. The rule-guided
    // dewarp rewrites every trace flat, but the remap can under-correct a
    // steep right-edge curl by 3-5px (warehouse2), so the printed rule's run
    // sits clear of the trace-centred core window. The excess pads below then
    // read the offset as "a stroke lying on the rule" and KEEP the print: the
    // surviving strips that welded half a line into one word box. A stroke ON
    // the rule genuinely thickens the run; a displaced clean run has no excess
    // of its own — its height is the rule's.
    //
    // What separates the rule from a mark that merely SHAPES like it per
    // column (democrat A's comma, page E's letter feet — both erased when this
    // fired per-column): a rule segment is horizontally CONTINUOUS, tens of
    // columns at a consistent centre, where a mark is a handful of columns
    // with a wandering one. So the erase needs STRIP SUPPORT — ≥9 of the ±8
    // neighbouring columns holding a rule-thin run whose centre agrees within
    // 1.5px — plus the run being no darker than the rule's own measured print
    // level. The same support gates the FAINT twin (a print run under the ink
    // gate entirely, which the walk below cannot even see).
    const runKind = new Uint8Array(W)          // 0 none · 1 ink-grade · 2 faint
    const runA = new Int32Array(W)
    const runB = new Int32Array(W)
    const runCent = new Float32Array(W)
    const runMin = new Uint8Array(W)
    for (let x = 0; x < W; x++) {
      const ry = ryArr[x]
      let seed = -1
      let thr = inkT2
      let kind = 1
      for (let k = 0; k < SEED_DY_WIDE.length; k++) {
        const y = ry + SEED_DY_WIDE[k]
        if (y >= 0 && y < H && gray[y * W + x] < inkT2) { seed = y; break }
      }
      if (seed < 0) {
        for (let k = 0; k < SEED_DY_WIDE.length; k++) {
          const y = ry + SEED_DY_WIDE[k]
          if (y >= 0 && y < H && gray[y * W + x] < measT) { seed = y; break }
        }
        thr = measT
        kind = 2
      }
      if (seed < 0) continue
      let a2 = seed, b2 = seed
      while (a2 > 0 && gray[(a2 - 1) * W + x] < thr) a2--
      while (b2 < H - 1 && gray[(b2 + 1) * W + x] < thr) b2++
      if (b2 - a2 + 1 > t + 2) continue        // not rule-thin: never a strip column
      runKind[x] = kind
      runA[x] = a2
      runB[x] = b2
      runCent[x] = (a2 + b2) / 2
      let mn = 255
      for (let yy = a2; yy <= b2; yy++) mn = Math.min(mn, gray[yy * W + x])
      runMin[x] = mn
    }
    // Two supports: `stripOK` (centre agreement alone — the faint branch's,
    // where the run is under the ink gate and cannot be a pen mark) and
    // `dispOK`, whose supporting neighbours must THEMSELVES sit off the trace.
    // Without that, a comma whose tail welds into an on-trace rule borrowed
    // the rule columns' support and lost its tail (democrat A's "me,").
    const stripOK = new Uint8Array(W)
    const dispOK = new Uint8Array(W)
    for (let x = 0; x < W; x++) {
      if (!runKind[x]) continue
      let n = 0
      let nOff = 0
      for (let dx = -8; dx <= 8; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= W || !runKind[xx]) continue
        if (Math.abs(runCent[xx] - runCent[x]) > 1.5) continue
        n++
        if (Math.abs(runCent[xx] - ryArr[xx]) >= 1.5) nOff++
      }
      if (n >= 9) stripOK[x] = 1
      if (nOff >= 9) dispOK[x] = 1
    }
    const dkRule = dkMeasured.get(r) ?? 255

    for (let x = 0; x < W; x++) {
      const ry = ryArr[x]
      // seed the run search at the darkest offset nearest the trace; ±4 so a
      // locally offset rule still finds its run — a missed seed used to drop
      // this column into "no rule here, keep everything", rule included
      let seed = -1
      for (let k = 0; k < SEED_DY.length; k++) {
        const y = ry + SEED_DY[k]
        if (y >= 0 && y < H && gray[y * W + x] < inkT2) { seed = y; break }
      }
      let a = 1, b = 0
      if (seed >= 0) {
        a = seed; b = seed
        while (a > 0 && gray[(a - 1) * W + x] < inkT2) a--
        while (b < H - 1 && gray[(b + 1) * W + x] < inkT2) b++
      }
      const coreTop = ry - coreUp, coreBot = ry + coreDn
      const y0b = Math.max(0, ry - hb), y1b = Math.min(H - 1, ry + hb)
      // An on-trace "thickPrint" twin (erase a thick print segment by colour
      // + support alone) was tried here and measured NET NEGATIVE (+2 pooled:
      // democrat A's comma-on-rule and risks1) — the off-trace requirement is
      // what keeps pen marks that hug the rule out of the erase.
      const stripRun = runKind[x] === 1 && runMin[x] >= dkRule - 25
        && dispOK[x] === 1 && Math.abs(runCent[x] - ry) >= 2
      // A run's EXCESS beyond the expected thickness is a stroke only when it
      // is substantial: a blurred rule fades 1-2px past the measured core on
      // page B and keeping that as "stroke" left the whole rule standing once
      // the residue erasers learned to respect keeps (2 -> 30 errors). A
      // stroke lying on the rule extends its full width, so 3px is the bar.
      const abovePad = seed >= 0 ? coreTop - a : 0
      const belowPad = seed >= 0 ? b - coreBot : 0
      // Walk the band's dark ink as SEGMENTS. Two hazards live at pixel level:
      // the located run's blur shoulders (handled by the >=3px pads), and the
      // rule's SECOND EDGE — printed rules scan hollow on some pages, so the
      // other edge is a separate 1-2px run hugging the core that a naive
      // separate-run keep preserved as a dashed phantom line (pages B/E). A
      // separate segment is stroke when it is SUBSTANTIAL (>=3px, a real pen
      // width) or sits clear of the core (>2px away); the core window itself
      // is never stamped — crossing strokes there survive the classifier's
      // own vertical-run test.
      let y = y0b
      while (y <= y1b) {
        if (gray[y * W + x] >= inkT2) { y++; continue }
        const s0 = y
        while (y <= y1b && gray[y * W + x] < inkT2) y++
        const s1 = y - 1
        const isTrace = seed >= 0 && !(s1 < a || s0 > b)
        // A displaced strip's segment never stamps a keep, whichever branch
        // would have caught it — it IS the rule.
        const isStrip = stripRun && !(s1 < runA[x] || s0 > runB[x])
        if (isTrace) {
          if (!isStrip) for (let yy = s0; yy <= s1; yy++) {
            if (yy >= coreTop && yy <= coreBot) continue
            if (yy < coreTop && abovePad >= 3) strokeStamp[yy * W + x] = stamp
            else if (yy > coreBot && belowPad >= 3) strokeStamp[yy * W + x] = stamp
          }
        } else if (!isStrip) {
          const thick = s1 - s0 + 1 >= 3
          const nearCore = s0 <= coreBot + 2 && s1 >= coreTop - 2
          if (thick || !nearCore) {
            for (let yy = s0; yy <= s1; yy++) {
              if (yy < coreTop || yy > coreBot) strokeStamp[yy * W + x] = stamp
            }
          }
        }
      }
      // A DISPLACED (or thick-print) strip is erased whole — its core is
      // wherever it lies.
      if (stripRun) {
        for (let y = Math.max(0, runA[x]); y <= Math.min(H - 1, runB[x]); y++) {
          if (y >= y0b && y <= y1b) continue   // the classify pass owns the band
          cls[y * W + x] = 1
          erased.push(y * W + x)
        }
      }
      // bent rule: erase the located run's core even where it leaves the band
      if (seed >= 0) {
        for (let y = Math.max(0, Math.max(a, coreTop)); y <= Math.min(H - 1, Math.min(b, coreBot)); y++) {
          if (y >= y0b && y <= y1b) continue   // the classify pass owns the band
          cls[y * W + x] = 1
          erased.push(y * W + x)
        }
      } else if (runKind[x] === 2 && stripOK[x] === 1) {
        // FAINT PRINT the ink gate cannot see: no inkT2 run, but a strip-
        // supported rule-thin run at the measure bar (paper-30) is print —
        // pen ink clears paper-45, which is the gate's own rationale — so its
        // out-of-band part is erased here (the classify pass already erases
        // the in-band part: too light to be an outlier, and the inkT2-gated
        // walk never stamps it).
        for (let y = Math.max(0, runA[x]); y <= Math.min(H - 1, runB[x]); y++) {
          if (y >= y0b && y <= y1b) continue
          cls[y * W + x] = 1
          erased.push(y * W + x)
        }
      }
    }

    // Classify every band pixel against the rule's expected colour.
    const band: number[] = []
    for (let y = yMin; y <= yMax; y++) {
      rowRunningMedian(gray, W, y, RM_WINDOW, med)
      for (let x = 0; x < W; x++) {
        const ry = ryArr[x]
        if (y < ry - hb || y > ry + hb) continue // outside this column's band
        const i = y * W + x
        expected[i] = med[x]
        band.push(i)
        const outlier = gray[i] + kd < med[x]
        let keep = false
        if (outlier) {
          // Dark run beyond the band on EITHER side = a real stroke (crossing, or a
          // letter body sitting above the baseline), not a rule pixel.
          const yTop = ry - hb
          const yBot = ry + hb
          let up = y
          let down = y
          while (up > 0 && y - up < reach && ink[(up - 1) * W + x]) up--
          while (down < H - 1 && down - y < reach && ink[(down + 1) * W + x]) down++
          keep = yTop - up >= RM_EXTEND || down - yBot >= RM_EXTEND
        }
        if (!keep && strokeStamp[i] === stamp) keep = true
        cls[i] = keep ? 2 : 1
        if (!keep) erased.push(i)
      }
    }

    // Connectivity rescue: a still-erased band pixel that is darker than the rule
    // (by the gentler rescueDelta) is kept when it connects — across small light
    // gaps — to a kept stroke pixel or to ink just outside the band. Multi-source
    // flood bounded to RM_GROW px so a long noisy rule can't rescue itself end to
    // end. Handles strokes that curve and run ALONG the rule (no vertical run).
    const rescuable = (i: number) => cls[i] === 1 && gray[i] + rescueDelta < expected[i]
    const isSource = (i: number) => cls[i] === 2 || (cls[i] === 0 && ink[i] === 1)
    const dist = new Map<number, number>()
    const queue: number[] = []
    for (const i of band) {
      if (!rescuable(i)) continue
      const x = i % W
      const y = (i / W) | 0
      let best = -1
      for (let dy = -RM_BRIDGE; dy <= RM_BRIDGE; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -RM_BRIDGE; dx <= RM_BRIDGE; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          if (isSource(yy * W + xx)) {
            const d = Math.max(Math.abs(dx), Math.abs(dy))
            if (best < 0 || d < best) best = d
          }
        }
      }
      if (best >= 0 && best <= RM_GROW) {
        cls[i] = 2
        dist.set(i, best)
        queue.push(i)
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi]
      const di = dist.get(i) ?? 0
      if (di >= RM_GROW) continue
      const x = i % W
      const y = (i / W) | 0
      for (let dy = -RM_BRIDGE; dy <= RM_BRIDGE; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -RM_BRIDGE; dx <= RM_BRIDGE; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const q = yy * W + xx
          if (dist.has(q) || !rescuable(q)) continue
          const nd = di + Math.max(Math.abs(dx), Math.abs(dy))
          if (nd > RM_GROW) continue
          cls[q] = 2
          dist.set(q, nd)
          queue.push(q)
        }
      }
    }
  }

  // A DOT SITTING ON THE RULE IS INVISIBLE TO BOTH KEEP TESTS.
  //
  // Measured on doubledia's `château.`: the period's core reaches gray 50-59
  // where the rule beside it is 182-204 — 130 levels darker, the least
  // ambiguous ink on the page — and it was erased whole, taking the sentence
  // end with it. Neither keep test can see it, and not by accident:
  //   - the RUN test wants the dark run to reach RM_EXTEND past the band, and a
  //     period is ~6px tall on a band that is ~7px tall, so it ends inside;
  //   - the run-EXCESS stamp compares against the core window (coreUp+coreDn,
  //     6px for a 3px rule, deliberately generous to swallow blur), and a
  //     period fits entirely inside that window — excess 1px against a 3px bar.
  // Both tests reason about SHAPE ALONG THE COLUMN, and a dot's whole
  // distinguishing feature is that it is compact and very dark. So this is a
  // third test rather than a loosening of either: among pixels the classifier
  // has already condemned, a COMPACT blob that is far darker than the rule's
  // own local colour is restored as a keep. It is deliberately the narrowest
  // reading of "keep it and let the recogniser decide" — nothing downstream
  // changes, the dot simply reaches the segmenter, which already knows how to
  // attach a period to the word beside it.
  //
  // NOT colour, which is the recorded negative above: this is luminance against
  // the rule's OWN running median, so a page written in blue on blue rules is
  // judged by how much darker the ink is, not by what hue it is.
  {
    const spacing: number[] = []
    for (let i = 1; i < rules.length; i++) {
      const a = rules[i - 1].y, b = rules[i].y
      const ca = a[a.length >> 1], cb = b[b.length >> 1]
      if (isFinite(ca) && isFinite(cb)) spacing.push(Math.abs(cb - ca))
    }
    spacing.sort((p, q) => p - q)
    const gapMed = spacing.length ? spacing[spacing.length >> 1] : 0
    const maxDot = Math.max(4, Math.round(gapMed > 0 ? gapMed * RD_MAX_FRAC : 12))
    const dotDelta = kd * RD_DELTA_MULT
    const seen = new Uint8Array(W * H)
    const stack: number[] = []
    const comp: number[] = []
    for (let ei = 0; ei < erased.length; ei++) {
      const s = erased[ei]
      {
      if (seen[s] || cls[s] !== 1 || !(gray[s] + dotDelta <= expected[s])) continue
      seen[s] = 1
      stack.length = 0; comp.length = 0
      stack.push(s)
      let x0 = W, x1 = -1, y0 = H, y1 = -1
      while (stack.length) {
        const i = stack.pop() as number
        comp.push(i)
        const y = (i / W) | 0, x = i - y * W
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) continue
            const q = yy * W + xx
            if (seen[q] || cls[q] !== 1 || !(gray[q] + dotDelta <= expected[q])) continue
            seen[q] = 1
            stack.push(q)
          }
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1
      if (bw < 2 || bh < 2 || bw > maxDot || bh > maxDot) continue     // a dot, not a streak or a speck
      const aspect = Math.max(bw / bh, bh / bw)
      if (aspect > RD_MAX_ASPECT) continue                              // ...and roughly round
      if (comp.length < RD_MIN_FILL * bw * bh) continue                 // ...and solid, not a wisp
      for (const i of comp) cls[i] = 2
      }
    }
  }

  // GROOVE SHAVE, detached components only. Streak residue at the rule comes
  // from a trace a few px off the true rule (weirdpage's dive dashes) or a
  // pen-pressure groove darkening the print (photorain), and the segmenter's
  // adaptive threshold resurrects even paper-10 leftovers as black. Per
  // column, structure within `win` of the trace is THIN (fits the rule's own
  // thickness), TALL, or TALL-AND-SPILLING past the window (a real stroke —
  // erased cls-1 pixels count as bright, or the not-yet-filled rule welds
  // everything tall). Candidate pixels live in thin columns; a candidate
  // COMPONENT is erased only when it touches no dark pixel of any spilling
  // column — attachment is the line geometry can actually draw. ATTACHED thin
  // runs are deliberately left alone: a capital L's base and an attached
  // groove are the same signal at pixel level (shaving them read "Listen" as
  // "L isten" and "be" as "he" — two measured casualties), so attached
  // residue belongs to recognition, not to this pass.
  // the 85th-percentile `paper` reads 255 on a flattened page (>15% of pixels
  // pure white), which makes a paper-relative darkness bar useless against
  // texture at 230-240 — the shave references the page MEDIAN instead
  let shavePaper = 255
  {
    let acc2 = 0
    for (let v = 0; v < 256; v++) {
      acc2 += hist[v]
      if (acc2 >= 0.5 * W * H) { shavePaper = v; break }
    }
  }
  const shaveCand = new Uint8Array(W * H)
  const shaveList: number[] = []   // every shaveCand pixel, once, for the flood's seeds
  const shaveWall = new Uint8Array(W * H)
  const stripMask: number[] = []
  for (const r of rules) {
    const t = tMeasured.get(r) ?? Math.min(r.thickness, 12)
    const hb = Math.max(1, t >> 1) + 2
    const win = hb + 6
    const thinMax = Math.max(4, t + 2)
    const shaveT = shavePaper - 18
    const kind = new Uint8Array(W) // 0 none · 1 thin · 2 tall · 3 tall+spilling
    const rest = new Uint8Array(W) // spilling column whose structure bottoms at the trace
    const top = new Int32Array(W)
    const bot = new Int32Array(W)
    const winTop = new Int32Array(W)
    const winBot = new Int32Array(W)
    for (let x = 0; x < W; x++) {
      const ry = Math.round(r.y[Math.min(x, r.y.length - 1)])
      const y0 = Math.max(1, ry - win)
      const y1 = Math.min(H - 2, ry + win)
      if (y1 < y0) { kind[x] = 0; continue }
      // a pixel already condemned (cls 1) counts as BRIGHT: the fill has not
      // run yet, so the erased rule is still dark in `gray`, and measuring it
      // as structure welds every residue to the rule below it — tall
      // everywhere, shave never fires (watched happen on weirdpage's dive)
      let a = -1
      let b = -1
      for (let y = y0, i = y0 * W + x; y <= y1; y++, i += W) {
        if (gray[i] < shaveT && cls[i] !== 1) { if (a < 0) a = y; b = y }
      }
      winTop[x] = y0
      winBot[x] = y1
      if (a < 0) { kind[x] = 0; continue }
      top[x] = a
      bot[x] = b
      const iU = (y0 - 1) * W + x, iD = (y1 + 1) * W + x
      const spillUp = a <= y0 && gray[iU] < shaveT && cls[iU] !== 1
      const spillDn = b >= y1 && gray[iD] < shaveT && cls[iD] !== 1
      const spills = spillUp || spillDn
      // 3 = tall AND spilling past the window — a real stroke. A tall column
      // that stays inside the window is blur/texture chaining or a compact
      // mark: its own pixels are never shaved, but it casts no protection.
      kind[x] = !spills && b - a + 1 <= thinMax ? 1 : spills ? 3 : 2
      if (kind[x] === 3 && !spillDn && b - ry >= -3 && b - ry <= 3) rest[x] = 1
    }
    // Does anything actually REST on this rule? A letter's foot is a stroke
    // whose structure BOTTOMS at the trace. A blank rule (the writer skips
    // every other printed rule) crosses ASCENDERS instead — strokes pass
    // through its window and nothing bottoms there — so attachment to them
    // protects nothing: whatever hangs on a passing stroke at a blank rule
    // is residue, not a foot.
    let restN = 0
    let tallN = 0
    for (let x = 0; x < W; x++) {
      if (kind[x] === 3) { tallN++; if (rest[x]) restN++ }
    }
    const protectedRule = restN >= Math.max(6, tallN * 0.1)
    // candidates at a GENTLER threshold than detection (the remover's fill
    // leaves paper-10..paper-18 residue the segmenter still resurrects);
    // walls at the detection threshold, in spilling columns of RESTED rules
    const faintT = shavePaper - 10
    for (let x = 0; x < W; x++) {
      if (kind[x] === 1) {
        // ...and only when the structure CENTRES near the trace: rules and
        // grooves live at the rule; a faint fragment of a letter bowl rides
        // higher in the window and is the recogniser's ink, not residue
        const ry = Math.round(r.y[Math.min(x, r.y.length - 1)])
        const cc = (top[x] + bot[x]) >> 1
        if (Math.abs(cc - ry) > hb + 4) continue
        for (let y = winTop[x]; y <= winBot[x]; y++) {
          const i = y * W + x
          // cls 0 ONLY: a cls-2 keep here is the dot-on-rule rescue's period
          // or a stamped stroke — re-erasing keeps is how the first version
          // of this pass deleted punctuation the rescue had just saved
          if (gray[i] < faintT && cls[i] === 0 && !shaveCand[i]) { shaveCand[i] = 1; shaveList.push(i) }
        }
        // a structure continuing past the window is not fully seen — erasing
        // the visible half leaves the rump beyond the window as a compact
        // blob (measured: "more" grew a false period). The outside pixel
        // anchors attachment so the component is left whole.
        const iT = (winTop[x] - 1) * W + x
        const iB = (winBot[x] + 1) * W + x
        if (winTop[x] > 0 && gray[iT] < faintT && shaveCand[winTop[x] * W + x]) shaveWall[iT] = 1
        if (winBot[x] < H - 1 && gray[iB] < faintT && shaveCand[winBot[x] * W + x]) shaveWall[iB] = 1
      } else if (kind[x] === 3 && protectedRule) {
        for (let y = winTop[x]; y <= winBot[x]; y++) {
          const i = y * W + x
          if (gray[i] < shaveT && cls[i] !== 1) shaveWall[i] = 1
        }
      } else if (kind[x] === 2) {
        // a compact tall column is a MARK (period, comma tail, dot) or a
        // texture chain. Its pixels are never shaved, but its faint AA skirt
        // spills into neighbouring thin columns as cls-0 candidates — without
        // a wall here the skirt reads detached and the mark erodes (measured:
        // commas 33 -> 31). Ink-grade darkness separates a mark from texture,
        // so only really-dark pixels anchor attachment.
        for (let y = winTop[x]; y <= winBot[x]; y++) {
          const i = y * W + x
          if (gray[i] < shavePaper - 40 && cls[i] !== 1) shaveWall[i] = 1
        }
      }
    }
  }
  // flood candidate components (8-connected); erase only the DETACHED ones
  {
    const seenS = new Uint8Array(W * H)
    const stack2: number[] = []
    const comp2: number[] = []
    for (let li = 0; li < shaveList.length; li++) {
      const s0 = shaveList[li]
      {
      if (!shaveCand[s0] || seenS[s0]) continue
      seenS[s0] = 1
      stack2.length = 0
      comp2.length = 0
      stack2.push(s0)
      let attached = false
      while (stack2.length) {
        const i = stack2.pop() as number
        comp2.push(i)
        const x = i % W
        const y = (i / W) | 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) continue
            const j = yy * W + xx
            if (shaveWall[j]) attached = true
            if (shaveCand[j] && !seenS[j]) { seenS[j] = 1; stack2.push(j) }
          }
        }
      }
      if (attached) continue
      for (const i of comp2) { cls[i] = 1; erased.push(i) }
      }
    }
  }

  // ATTACHED-STRIP CARVE (shave pass 2, user-designed). A remaining rule part
  // is a thin horizontal strip AT the rule, no thicker than the print, and
  // LONG relative to x-height — a letter's foot or bowl bottom is short
  // (under RM_STRIP's length trigger) and as dark as its own letter. So for
  // each long-enough strip run along a trace: measure two darkness levels —
  // the strip's own (thin columns) and the characters it touches (columns
  // whose structure continues past the band) — and when the strip is clearly
  // LIGHTER than its characters, erase the strip columns and keep the darker
  // parts that join a character (plus a one-column contact margin). A strip
  // as dark as its characters is real ink (a drawn underline, a long base
  // stroke) and is left whole; a strip touching no character at all belongs
  // to pass 1.
  {
    const spacing2: number[] = []
    for (let i = 1; i < rules.length; i++) {
      const a = rules[i - 1].y
      const b = rules[i].y
      const ca = a[a.length >> 1]
      const cb = b[b.length >> 1]
      if (isFinite(ca) && isFinite(cb)) spacing2.push(Math.abs(cb - ca))
    }
    spacing2.sort((p, q) => p - q)
    const gapMed2 = spacing2.length ? spacing2[spacing2.length >> 1] : 40
    const minLen = Math.max(18, Math.round(gapMed2 * 0.36))
    const faintT2 = shavePaper - 10
    for (const r of rules) {
      const t = Math.min(r.thickness, 12)
      const tM = tMeasured.get(r) ?? t
      const band = t + 3
      const present = new Uint8Array(W)
      const coreDark = new Int32Array(W).fill(255)
      const st0 = new Int32Array(W)
      const st1 = new Int32Array(W)
      const spillC = new Uint8Array(W)
      const charDark = new Int32Array(W).fill(255)
      for (let x = 0; x < W; x++) {
        const ry = Math.round(r.y[Math.min(x, r.y.length - 1)])
        const y0 = Math.max(1, ry - band)
        const y1 = Math.min(H - 2, ry + band)
        if (y1 < y0) continue
        // the structure is the CONTIGUOUS dark run nearest the trace — not
        // the window's full dark extent, which under a letter spans the
        // letter's arc PLUS the strip (too tall, never flat, never a
        // candidate: the blocker that kept every under-letter strip standing)
        // dark-and-not-condemned, nearest the trace first (0, -1, +1, -2, +2 …)
        let seed = -1
        for (let dd = 0; dd <= band - 1 && seed < 0; dd++) {
          for (let sgn = dd === 0 ? 1 : -1; sgn <= 1; sgn += 2) {
            const y = ry + sgn * dd
            if (y < y0 || y > y1) continue
            const i = y * W + x
            if (cls[i] !== 1 && gray[i] < faintT2) { seed = y; break }
          }
        }
        if (seed < 0) continue
        let a = seed
        let b = seed
        while (a > y0 && cls[(a - 1) * W + x] !== 1 && gray[(a - 1) * W + x] < faintT2) a--
        while (b < y1 && cls[(b + 1) * W + x] !== 1 && gray[(b + 1) * W + x] < faintT2) b++
        let dMin = 255
        for (let y = a; y <= b; y++) {
          const g = gray[y * W + x]
          if (g < dMin) dMin = g
        }
        present[x] = 1
        coreDark[x] = dMin
        st0[x] = a
        st1[x] = b
        // a CHARACTER continuing past the band is real ink — at the faint
        // threshold, texture pixels read as "characters", C measures junk
        // instead of letter ink, and every long run dies on G-C. The
        // character-darkness sample reads the CONNECTING stroke itself (a few
        // px past the band), not the band content, or a column whose band
        // holds only faint residue under a real letter pollutes C upward.
        const inkG = shavePaper - 40
        const upI = (y0 - 1) * W + x
        const dnI = (y1 + 1) * W + x
        let strokeD = 255
        // the structure must TOUCH the window edge to spill (pass 1 already
        // required this): without the touch condition, a letter arc floating
        // above the band — the o's bowl over its own underline — marks the
        // column as stroke contact and the whole under-letter strip reads as
        // protected
        if (a <= y0 && gray[upI] < inkG && cls[upI] !== 1) {
          spillC[x] = 1
          for (let y = Math.max(0, y0 - 3); y < y0; y++) {
            const i = y * W + x
            if (cls[i] !== 1 && gray[i] < strokeD) strokeD = gray[i]
          }
        }
        if (b >= y1 && gray[dnI] < inkG && cls[dnI] !== 1) {
          spillC[x] = 1
          for (let y = y1 + 1; y <= Math.min(H - 1, y1 + 3); y++) {
            const i = y * W + x
            if (cls[i] !== 1 && gray[i] < strokeD) strokeD = gray[i]
          }
        }
        if (spillC[x]) charDark[x] = Math.min(coreDark[x], strokeD)
      }
      // distance (columns) to the nearest spilling stroke, both directions
      const dL = new Int32Array(W)
      const dR = new Int32Array(W)
      let lastS = -W * 2
      for (let x2 = 0; x2 < W; x2++) {
        if (spillC[x2]) lastS = x2
        dL[x2] = x2 - lastS
      }
      lastS = W * 3
      for (let x2 = W - 1; x2 >= 0; x2--) {
        if (spillC[x2]) lastS = x2
        dR[x2] = lastS - x2
      }
      let x = 0
      while (x < W) {
        if (!present[x]) { x++; continue }
        let e = x
        let gap = 0
        let xe = x
        while (e < W - 1) {
          if (present[e + 1]) { e++; xe = e; gap = 0 }
          else if (gap < 2) { e++; gap++ }
          else break
        }
        const s0x = x
        x = e + 1
        if (xe - s0x + 1 < minLen) continue
        // DISTANCE-GRADED strip removal (user-designed; fitted to the painted
        // strip labels): a run that sits RIGHT OVER the rule and stays almost
        // exactly horizontal is the rule's own body wherever it is far from a
        // stroke that extends above/below — WHATEVER its darkness, which is
        // what the pen-pressure grooves defeat in the G-C test below. Grading,
        // from the paints: beyond RM_STRIP_FAR of the nearest spilling stroke
        // the whole thin structure goes; nearer (but past the contact margin)
        // only the underhang below the trace goes (the d-in-shouted paint).
        // Never touched: spans bridging two strokes within RM_STRIP_GAP (bowl
        // bottoms, base bars), and columns thicker than the measured print
        // plus blur (pen ink ON the rule — an L's base bar).
        {
          // DISPLAY-ONLY: this branch marks pixels into `stripMask` instead of
          // cls — the decode gate priced cls-erasure at 8-11 photo words
          // (on light-ink pages a broken letter's foot IS a thin flat run far
          // from its own spilling stroke), while the visual complaint lives
          // in the RENDER. The caller applies the mask to segPage after the
          // decode (the restoreDots pattern), so reading is untouched.
          // the strip's own line: median SIGNED deviation of thin columns
          // from the trace. Each column is judged against that line — a
          // letter arc riding above the strip diverges from it and is
          // skipped individually, instead of poisoning a whole-run flatness
          // gate (which is how the under-letter strips kept surviving)
          const devs: number[] = []
          for (let xx = s0x; xx <= xe; xx++) {
            if (!present[xx] || spillC[xx]) continue
            const ryx = Math.round(r.y[Math.min(xx, r.y.length - 1)])
            devs.push((st0[xx] + st1[xx]) / 2 - ryx)
          }
          devs.sort((p, q) => p - q)
          const m = devs.length ? devs[devs.length >> 1] : 0
          if (devs.length >= 8) {
            for (let xx = s0x; xx <= xe; xx++) {
              if (!present[xx] || spillC[xx]) continue
              const ryx = Math.round(r.y[Math.min(xx, r.y.length - 1)])
              const dev = (st0[xx] + st1[xx]) / 2 - ryx
              if (Math.abs(dev - m) > 1.5) continue
              const d = Math.min(dL[xx], dR[xx])
              if (d <= RM_STRIP_NEAR) continue
              const h = st1[xx] - st0[xx] + 1
              // the bridge guard blocks only FULL removal — the underhang
              // BELOW the trace is print even inside a bridge (the rule under
              // a bowl bottom, the groove under an o's arc)
              if (d > RM_STRIP_FAR && dL[xx] + dR[xx] > RM_STRIP_GAP && h <= tM + 1) {
                for (let y = st0[xx]; y <= st1[xx]; y++) stripMask.push(y * W + xx)
              } else {
                const u0 = Math.max(st0[xx], ryx + 1)
                if (st1[xx] >= u0 && st1[xx] - u0 + 1 <= tM) {
                  for (let y = u0; y <= st1[xx]; y++) stripMask.push(y * W + xx)
                }
              }
            }
          }
        }
        const gs: number[] = []
        const cs: number[] = []
        for (let xx = s0x; xx <= xe; xx++) {
          if (!present[xx]) continue
          if (spillC[xx]) cs.push(charDark[xx])
          else gs.push(coreDark[xx])
        }
        if (!gs.length || !cs.length) continue
        gs.sort((p, q) => p - q)
        cs.sort((p, q) => p - q)
        const G = gs[gs.length >> 1]
        const C = cs[cs.length >> 1]
        // the strip itself must be lighter than ink-grade: a run whose thin
        // columns are pen-dark is written ink whatever its contrast to the
        // letters (G=122 on "be"'s bowl region carved the bowl again)
        if (G - C < 25 || G < shavePaper - 60) continue
        const mid = (G + C) >> 1
        for (let xx = s0x; xx <= xe; xx++) {
          if (!present[xx] || spillC[xx]) continue
          if (coreDark[xx] < mid) continue
          if ((xx > 0 && spillC[xx - 1]) || (xx < W - 1 && spillC[xx + 1])) continue
          for (let y = st0[xx]; y <= st1[xx]; y++) { cls[y * W + xx] = 1; erased.push(y * W + xx) }
        }
      }
    }
  }

  // RESIDUE CENSUS — which rules are HARD. Per rule, count the strip-like
  // dark pixels still standing in the band after every pass above (thin
  // structures only, so letter feet resting on a written rule do not count),
  // attached to the returned verdicts as `ruleStats` and summarised on the
  // console when a rule is notably dirty — "this rule resists removal"
  // becomes a number a lab can rank instead of a hunch.
  {
    const hist2 = new Int32Array(256)
    for (let i = 0; i < W * H; i += 7) hist2[gray[i]]++
    let acc3 = 0
    let medPaper = 255
    const tot = Math.ceil((W * H) / 7)
    for (let v = 0; v < 256; v++) {
      acc3 += hist2[v]
      if (acc3 >= 0.5 * tot) { medPaper = v; break }
    }
    const resT = medPaper - 18
    const stats: { y: number; t: number; residue: number }[] = []
    for (const r of rules) {
      const t = tMeasured.get(r) ?? Math.min(r.thickness, 12)
      let n = 0
      for (let x = 0; x < W; x += 2) {
        const ry = Math.round(r.y[Math.min(x, r.y.length - 1)])
        const y0 = Math.max(1, ry - t - 3)
        const y1 = Math.min(H - 2, ry + t + 3)
        let a = -1
        let b = -1
        for (let y = y0; y <= y1; y++) {
          const i = y * W + x
          if (cls[i] !== 1 && gray[i] < resT) { if (a < 0) a = y; b = y }
        }
        if (a < 0) continue
        if (b - a + 1 > t + 2) continue                       // letter-sized, not strip
        if (gray[(y0 - 1) * W + x] < resT || gray[(y1 + 1) * W + x] < resT) continue
        for (let y = a; y <= b; y++) if (cls[y * W + x] !== 2) n++
      }
      const ys = r.y[r.y.length >> 1]
      stats.push({ y: Math.round(Number(ys)), t, residue: n * 2 })
    }
    ;(cls as unknown as { ruleStats?: unknown }).ruleStats = stats
    ;(cls as unknown as { stripMask?: unknown }).stripMask = stripMask
    const dirty = stats.filter((st) => st.residue > W * 0.05).sort((p, q) => q.residue - p.residue)
    if (dirty.length) {
      debugLog(() => `[hw rules] residue after removal: ${dirty.slice(0, 6)
        .map((st) => `y${st.y}~${st.residue}px(t${st.t})`).join(' ')}${dirty.length > 6 ? ' …' : ''}`)
    }
  }

  // Fill erased (rule) pixels from the nearest paper-coloured pixel above/below in
  // the same column, so nothing dark is left where the rule was and kept strokes
  // are untouched. Kept pixels (cls 2) are neither filled nor a fill source.
  for (let ei = 0; ei < erased.length; ei++) {
    const i = erased[ei]
    {
    if (cls[i] !== 1) continue
    const x = i % W
    const y = (i / W) | 0
    let ya = -1
    let yb = -1
    for (let d = 1; d <= H; d++) {
      const up = y - d >= 0
      const dn = y + d < H
      if (!up && !dn) break
      if (ya < 0 && up) {
        const j = (y - d) * W + x
        if (cls[j] === 0 && gray[j] >= inkT) ya = y - d
      }
      if (yb < 0 && dn) {
        const j = (y + d) * W + x
        if (cls[j] === 0 && gray[j] >= inkT) yb = y + d
      }
      if (ya >= 0 && yb >= 0) break
    }
    let v: number
    if (ya >= 0 && yb >= 0) {
      const tt = (y - ya) / (yb - ya)
      v = gray[ya * W + x] * (1 - tt) + gray[yb * W + x] * tt
    } else if (ya >= 0) v = gray[ya * W + x]
    else if (yb >= 0) v = gray[yb * W + x]
    else v = paper
    gray[i] = Math.round(v)
    }
  }

  return cls
}

/** Erase the vertical margin band across the whole page, keeping HORIZONTAL
 *  crossing strokes (ink both left and right of the band). */
function removeVRulePage(gray: Uint8Array, W: number, H: number, vrules: VRuleTrace[]): void {
  for (const v of vrules) {
    if (v.x.length < H) continue
    const t = Math.min(v.thickness, 20)
    const hb = Math.max(1, t >> 1) + 3
    for (let y = 0; y < H; y++) {
      const cx = Math.round(v.x[y])
      let inkL = false
      let inkR = false
      for (let d = 1; d <= RULE_REMOVE_EXTEND; d++) {
        const xl = cx - hb - d
        const xr = cx + hb + d
        if (xl >= 0 && gray[y * W + xl] < RULE_REMOVE_INK) inkL = true
        if (xr < W && gray[y * W + xr] < RULE_REMOVE_INK) inkR = true
      }
      if (inkL && inkR) continue
      const xl = Math.max(0, cx - hb - 1)
      const xr = Math.min(W - 1, cx + hb + 1)
      const fill = Math.max(gray[y * W + xl], gray[y * W + xr])
      for (let x = Math.max(0, cx - hb); x <= Math.min(W - 1, cx + hb); x++) gray[y * W + x] = fill
    }
  }
}

/** The rule-removal classification over the ORIGINAL page: RED = erased as rule,
 *  GREEN = kept as stroke (crossing/resting/along the rule). Everything else is the
 *  untouched page. Lets a writer see exactly which pixels the remover judged text. */
function ruleMaskOverlay(orig: Uint8Array, W: number, H: number, cls: Uint8Array): string {
  const img = new ImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    const g = orig[i]
    const o = i * 4
    if (cls[i] === 1) {
      img.data[o] = 220
      img.data[o + 1] = Math.min(255, g >> 1)
      img.data[o + 2] = Math.min(255, g >> 1)
    } else if (cls[i] === 2) {
      img.data[o] = Math.min(255, g >> 1)
      img.data[o + 1] = 170
      img.data[o + 2] = Math.min(255, g >> 1)
    } else {
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g
    }
    img.data[o + 3] = 255
  }
  return canvasOf(img).toDataURL('image/png')
}

function grayImageData(gray: Uint8Array, W: number, H: number): ImageData {
  const img = new ImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i]
    img.data[i * 4 + 3] = 255
  }
  return img
}

function grayToPng(gray: Uint8Array, W: number, H: number): string {
  return canvasOf(grayImageData(gray, W, H)).toDataURL('image/png')
}

interface Band { x: number; y: number; w: number; h: number; base: number }

/** Rule-removed page with each line band + baseline drawn on it. */
function cleanBandsOverlay(gray: Uint8Array, W: number, H: number, bands: Band[]): string {
  const c = canvasOf(grayImageData(gray, W, H))
  const ctx = c.getContext('2d')!
  ctx.lineWidth = 2
  bands.forEach((b, i) => {
    ctx.strokeStyle = lineColor(i)
    ctx.strokeRect(b.x, b.y, b.w, b.h)
    ctx.strokeStyle = 'rgba(220,38,38,0.8)'
    ctx.beginPath()
    ctx.moveTo(b.x, b.base + 0.5)
    ctx.lineTo(b.x + b.w, b.base + 0.5)
    ctx.stroke()
  })
  return c.toDataURL('image/png')
}

/**
 * Build one GRAYSCALE strip per line directly. Remove the rules at the page level
 * (so characters aren't joined by a rule and the margin is fully gone), find every
 * character as a CONNECTED COMPONENT on the whole page, assign each to its nearest
 * baseline, then size each line's strip to the UNION of its characters' actual
 * extents — so a tall letter can't be clipped by a fixed band.
 */
export function runTrainingPassB(cache: TrainPassA, opts?: TrainImportOptions): TrainImportResult {
  const { pa, marginRightX } = cache
  const W = pa.pageW
  const H = pa.pageH
  const gray = pa.gray.slice()
  removeVRulePage(gray, W, H, pa.rules.vrules ?? [])
  const ruleCls = removeHRulesPage(
    gray,
    W,
    H,
    pa.rules.rules,
    opts?.ruleKeepDelta ?? RM_KEEP_DELTA_DEF,
  )

  const rulesSorted = [...pa.rules.rules].sort((a, b) => ruleMedianY(a) - ruleMedianY(b))
  const mys = rulesSorted.map(ruleMedianY)
  const gaps: number[] = []
  for (let i = 1; i < mys.length; i++) gaps.push(mys[i] - mys[i - 1])
  gaps.sort((a, b) => a - b)
  const lineHeight = gaps.length ? gaps[gaps.length >> 1] : Math.max(12, Math.round(H / 25))

  const pad = Math.max(2, Math.round(lineHeight * 0.06))
  // Drop anything ENTIRELY left of the margin rule (pure margin junk); the rule
  // itself is already erased by removeVRulePage, so we do NOT clip pixels at the
  // margin — a letter that reaches left of it keeps its full left extent.
  const marginCut = Math.max(0, Math.round(marginRightX))

  const hist = new Int32Array(256)
  for (let i = 0; i < W * H; i++) hist[gray[i]]++
  const pctv = (f: number) => {
    let a = 0
    const t = f * W * H
    for (let v = 0; v < 256; v++) {
      a += hist[v]
      if (a >= t) return v
    }
    return 255
  }
  const paper = pctv(0.85)
  // A pixel is ink if it's at least `inkDark` darker than paper. A blob is kept
  // only if its darkness STRENGTH (Σ of normalized darkness^power over its ink
  // pixels) clears `minStrength` — so a few really dark pixels count, but many
  // faint ones don't. All three are user-tunable sliders.
  const inkDark = Math.max(1, Math.round(opts?.inkDark ?? INK_DARK_DEF))
  const inkT = Math.max(0, paper - inkDark)
  const minStrength = Math.max(0, opts?.minStrength ?? MIN_STRENGTH_DEF)
  const power = Math.max(0.5, opts?.darkPower ?? DARK_POWER_DEF)
  const bridgePx = Math.max(0, Math.round(opts?.bridgePx ?? BRIDGE_DEF))
  const maxCharH = lineHeight * 3 // taller than this = merged lines / artifact
  // A much lower floor for DOT candidates — a small/faint blob that fails the main
  // strength gate is kept only if a real letter sits below it (validated later),
  // so we can rescue faint i/j dots without letting page noise through.
  const dotFloor = Math.min(minStrength, Math.max(0.5, minStrength * 0.15))

  // Original ink, then a gap-bridged copy used ONLY for connectivity (so a stroke
  // split by a tiny gap is still one blob). Bbox / strength / mask use ONLY the
  // original ink, so the bridging never fattens the exported glyph.
  const ink = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (gray[i] < inkT) ink[i] = 1
  const bridged = dilateMask(ink, W, H, bridgePx)

  const label = new Int32Array(W * H).fill(-1)
  const stack: number[] = []
  interface Comp { root: number; x0: number; y0: number; x1: number; y1: number; line: number; strong: boolean }
  const comps: Comp[] = []
  for (let s = 0; s < W * H; s++) {
    if (label[s] >= 0 || !bridged[s]) continue
    label[s] = s
    stack.length = 0
    stack.push(s)
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    let strength = 0
    while (stack.length) {
      const i = stack.pop() as number
      const y = (i / W) | 0
      const x = i - y * W
      if (ink[i]) {
        // Only real ink contributes to the box + strength.
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        const d = (paper - gray[i]) / 255
        strength += d > 0 ? Math.pow(d, power) : 0
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const q = yy * W + xx
          if (label[q] < 0 && bridged[q]) {
            label[q] = s
            stack.push(q)
          }
        }
      }
    }
    if (x1 < 0) continue // no ink (shouldn't happen)
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    // Drop rule residue (tall AND thin) and absurdly tall blobs (two merged lines),
    // but NEVER a large WIDE letter — height alone must not disqualify a character.
    // The height bar is deliberately high: a tall THIN letter (l, I, 1, t, and the
    // stroke of !, ?) can reach well past one line-height when the writing is large
    // or a spurious rule shrank lineHeight, so only a fragment spanning SEVERAL lines
    // reads as a leftover vertical rule (the full margin rule is page-removed already,
    // and anything past 3 line-heights is caught below).
    if (bh > lineHeight * 2.5 && bw < bh * 0.35) continue // tall & thin = vertical rule
    if (bh > maxCharH) continue // > 3 line-heights = merged lines / artifact
    if (marginCut > 0 && x1 < marginCut) continue // entirely inside the margin
    const strong = strength >= minStrength
    if (!strong) {
      // Weak blob: only keep DOT-sized ones (a large faint blob is just noise), and
      // only above the low dot floor. Whether to actually keep it is decided below,
      // once we know if a letter sits beneath it.
      if (strength < dotFloor) continue
      if (bw > lineHeight * 0.6 || bh > lineHeight * 0.6) continue
    }
    comps.push({ root: s, x0, y0, x1, y1, line: -1, strong })
  }

  // Rescue weak dot candidates: keep one only if a STRONG letter body sits just
  // below it (roughly over it in x, small vertical gap) — that validates it as an
  // i/j dot / accent rather than a stray speck. Strong blobs are always kept.
  const bodyMinH = lineHeight * 0.3
  const bodies = comps.filter((c) => c.strong && c.y1 - c.y0 + 1 >= bodyMinH)
  const hLee = lineHeight * 0.45
  const hasBodyBelow = (c: Comp): boolean => {
    const cx = (c.x0 + c.x1) / 2
    for (const b of bodies) {
      if (b === c) continue
      if (cx < b.x0 - hLee || cx > b.x1 + hLee) continue // dot must sit ~over the body
      const vgap = b.y0 - c.y1 // body starts below the dot
      if (vgap >= -lineHeight * 0.2 && vgap <= lineHeight * 0.6) return true
    }
    return false
  }
  const kept = comps.filter((c) => c.strong || hasBodyBelow(c))

  // Baseline assignment — the rule a character RESTS ON. A letter sits on the
  // GREATEST baseline at/above its bottom, so a descender's tail (g, j, p, q, y)
  // hangs BELOW its rule instead of dragging the letter down to the next line.
  // If the chosen rule turns out to be ABOVE the whole blob (an i/j dot pulled up
  // to the line above — the dot floats entirely below the rule above it), DROP
  // DOWN to the next rule so the dot lands on its own line with its stem.
  const restSlack = lineHeight * 0.2
  const assign = (c: Comp): number => {
    const h = c.y1 - c.y0 + 1
    let rest = -1
    for (let li = 0; li < mys.length; li++) {
      if (mys[li] <= c.y1 + restSlack) rest = li
      else break // baselines are sorted ascending
    }
    if (rest < 0) rest = 0 // blob is above every rule → nearest rule is the first
    // If nearly all of the shape (>90% of its height) sits BELOW the chosen baseline,
    // it belongs to the line below — drop to the next baseline so it rests on that one.
    // This catches an upper stroke — the tall part of ! or ?, or an i/j dot — that
    // floats above its own baseline: its bottom never reaches the baseline, so the
    // bottom-based pick above lands a line too high. Descenders stay put (their body
    // keeps them well under 90% below their own baseline).
    while (rest + 1 < mys.length && mys[rest] < c.y0 + 0.1 * h) rest++
    // Reject only a blob no rule is anywhere near (floating junk between lines). The
    // LOWER bound is measured from the shape's TOP, not its bottom: an upper stroke
    // that legitimately belongs to this line (its dot rests on the baseline while the
    // stroke floats above it) must not be dropped just because its own bottom sits
    // far above the baseline.
    if (mys[rest] < c.y0 - lineHeight * 0.75 || mys[rest] > c.y0 + lineHeight * 1.4) return -1
    return rest
  }
  for (const c of kept) c.line = assign(c)

  const perLine = new Map<number, Comp[]>()
  for (const c of kept) {
    if (c.line < 0) continue
    const arr = perLine.get(c.line) ?? []
    arr.push(c)
    perLine.set(c.line, arr)
  }

  // Build one MASKED crop per connected blob: copy only that blob's own pixels
  // (label === root) onto white, so a tall/overlapping neighbour never bleeds in.
  const maskedCrop = (c: Comp): { data: ImageData; x0: number; y0: number; x1: number; y1: number } => {
    const cx0 = Math.max(0, c.x0 - pad)
    const cy0 = Math.max(0, c.y0 - pad)
    const cx1 = Math.min(W - 1, c.x1 + pad)
    const cy1 = Math.min(H - 1, c.y1 + pad)
    const cw = cx1 - cx0 + 1
    const ch = cy1 - cy0 + 1
    const img = new ImageData(cw, ch)
    img.data.fill(255)
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const pi = (cy0 + yy) * W + (cx0 + xx)
        // Only this blob's OWN original ink (bridged-but-not-ink pixels excluded).
        if (label[pi] === c.root && ink[pi]) {
          const o = (yy * cw + xx) * 4
          const g = gray[pi]
          img.data[o] = img.data[o + 1] = img.data[o + 2] = g
          img.data[o + 3] = 255
        }
      }
    }
    return { data: img, x0: cx0, y0: cy0, x1: cx1, y1: cy1 }
  }

  const lines: TrainLine[] = []
  const bands: Band[] = []
  for (let li = 0; li < mys.length; li++) {
    const cs = perLine.get(li)
    if (!cs || cs.length < 2) continue // blank / spurious line
    cs.sort((a, b) => a.x0 - b.x0)
    const baselineY = mys[li]
    const comps: TrainComponent[] = cs.map((c) => {
      const m = maskedCrop(c)
      bands.push({ x: m.x0, y: m.y0, w: m.x1 - m.x0 + 1, h: m.y1 - m.y0 + 1, base: baselineY })
      return { gray: m.data, x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 }
    })
    lines.push({ index: lines.length, components: comps, baselineY })
  }

  const cleaned = grayToPng(gray, W, H)
  const heightsArr = lines
    .flatMap((l) => l.components.map((c) => c.y1 - c.y0 + 1))
    .sort((a, b) => a - b)
  const unitPx = heightsArr.length ? heightsArr[heightsArr.length >> 1] : 24

  const debug: TrainDebug = {
    pageW: W,
    pageH: H,
    flatRules: rulesOverlay(pa),
    cleanBoxes: cleanBandsOverlay(gray, W, H, bands),
    baselines: cleanBandsOverlay(gray, W, H, bands),
    crops: cleanBandsOverlay(gray, W, H, bands),
    ruleMask: ruleMaskOverlay(pa.gray, W, H, ruleCls),
    cleaned,
    preThreshold: stackStrips(lines.map((l) => lineToStrip(l))),
    dewarp: cache.dewarp,
    dewarpRules: cache.dewarpRules,
    dewarpNote: cache.dewarpNote,
    stats: {
      rules: pa.rules.rules.length,
      vrules: pa.rules.vrules?.length ?? 0,
      segLines: lines.length,
      boxes: lines.length,
      recs: lines.length,
      withSmooth: lines.length,
      lineGroups: lines.length,
      byStatus: {},
    },
  }
  return { lines, unitPx, debug }
}

/** One-shot import (Pass A + Pass B) → grayscale strips. */
export async function importTrainingPage(
  img: HTMLImageElement,
  opts?: TrainImportOptions,
): Promise<TrainImportResult> {
  const cache = await runTrainingPassA(img, opts)
  return runTrainingPassB(cache, opts)
}

// ── word segmentation (editor-identical) ──────────────────────────────────────
// The character trainer (runTrainingPassB) finds single characters. The WORD trainer
// needs to break lines into words EXACTLY as the production editor's import does, so
// instead of reimplementing it we run the editor's own path here:
//   improveRules (catch/refine/measure rules) → rule-removed scratch page
//   (removeVRules + removeHRulesPage) → ccWordBoxes (CC blob gate + i/j-dot rescue +
//   core-extent gap word split). See handwritingV2/index.ts for the same sequence.
// The only extra step is cropping each word rectangle from the rule-removed page for
// display/export; Pass B (the editor's per-word normalize/SDF) is intentionally NOT
// run — the trainer wants clean binarizable crops, like the character trainer.

/** One word crop for the word-training tool: a rectangular grayscale crop from the
 *  rule-removed page (dark ink on light paper) + its baseline row within the crop. */
export interface TrainWord {
  gray: ImageData
  /** Baseline row within `gray`. */
  baselineRow: number
  /** Page bbox (stable identity across re-renders). */
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface TrainWordLine {
  index: number
  /** Index into `TrainWordResult.ruleYs` — which detected rule this line sits on. Gaps in
   *  this sequence are ruled lines with no writing on them (the blank lines a code block
   *  needs to keep). */
  rule: number
  /** Page-y of the line's baseline. */
  baselineY: number
  words: TrainWord[]
}

/** Intermediate-stage overlays for the word-training debug panel. */
export interface TrainWordDebug {
  pageW: number
  pageH: number
  /** Flat (dewarped/illumination-flattened) page + the rules that are USED (green) and
   *  the rules that were PRUNED as text-crossing (dashed magenta) + vertical margin
   *  (blue). Pruned rules are dropped before segmentation. */
  flatRules: string
  /** The rule-removed page the segmenter actually runs on (rules + margin gone). */
  cleaned: string
  /** The per-CHARACTER cleaned page: every character block thresholded with its own Otsu
   *  and re-rendered at one page-wide ink darkness, on pure paper. Ink outside any
   *  character is gone. This is what the crops are cut from by default. */
  charsClean: string
  /** Cleaned page + every CONNECTED-COMPONENT character box: GREEN = kept as a solid
   *  letter (counts toward word gaps), ORANGE = a thin/dot-like mark (attached to a
   *  word, never splits one). A missing letter shows as no box; a tiny speck that got
   *  a box is a false blob. */
  charBoxes: string
  /** Cleaned page + the final WORD boxes, colored per line, with each line's baseline. */
  wordBoxes: string
  stats: {
    rules: number
    rulesPruned: number
    chars: number
    words: number
    lineGroups: number
    /** The word-break gap (px) auto/manual actually used — read off the optimum here. */
    gapThreshold: number
    /** Components that held characters from TWO lines (a descender resting on the line
     *  below) and were cut apart by the seam separator. */
    crossSplits: number
  }
}

export interface TrainWordResult {
  lines: TrainWordLine[]
  debug: TrainWordDebug
  stats: { rules: number; words: number; lineGroups: number }
  /** The page every crop is cut from — so a caller can cut its own regions (the code
   *  trainer's fixed-width, indentation-preserving line bands). `gray` is what the crops
   *  actually used (the per-character cleaned page unless `cleanChars: false`); `raw` is
   *  the rule-removed page before per-character cleaning. */
  page: { gray: Uint8Array; raw: Uint8Array; W: number; H: number }
  /** Per-pixel line ownership over `page` (line index + 1; 0 = unclaimed). Pass it to
   *  `cropGrayRegion` to whiten the ink of every OTHER line inside a crop. */
  lineMask: Int16Array
  /** EVERY detected rule baseline (page y), top→bottom — including the ruled lines that
   *  have no writing on them. `TrainWordLine.rule` indexes into this. */
  ruleYs: number[]
  /** Median spacing between rules (px). */
  lineHeight: number
}

export interface TrainWordOptions extends TrainImportOptions {
  /** Manual word-break gap (px). 0 = automatic (2-means + line-height fallback). */
  wordGap?: number
  /** Auto-split 2-group separation needed to accept the clustered threshold. */
  gapSeparation?: number
  /** Multiplier on the AUTO word-gap threshold (< 1 = more words, > 1 = fewer).
   *  Ignored when wordGap > 0. Default 0.7. */
  autoScale?: number
  /** Whiten ink belonging to OTHER lines inside each word crop (a descender from the line
   *  above dipping into this word's rectangle). Default true. */
  trimForeignLines?: boolean
  /** Cut crops from the per-character cleaned page — each character block thresholded with
   *  its OWN Otsu and re-rendered at one page-wide ink darkness. Default true; false uses
   *  the raw rule-removed page (the old behaviour). */
  cleanChars?: boolean
}

/** Flat page + the USED rules (green), the PRUNED text-crossing rules (dashed magenta),
 *  and the vertical margin (blue). */
function flatRulesOverlay(
  flat: ImageData,
  rules: RuleTrace[],
  pruned: RuleTrace[],
  vrules: VRuleTrace[],
): string {
  const c = canvasOf(flat)
  const ctx = c.getContext('2d')!
  const drawH = (r: RuleTrace) => {
    ctx.beginPath()
    for (let x = 0; x < r.y.length; x++) (x ? ctx.lineTo(x, r.y[x]) : ctx.moveTo(x, r.y[x]))
    ctx.stroke()
  }
  // Pruned rules first (dashed magenta), so a kept rule drawn over them still reads.
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.strokeStyle = 'rgba(217,70,239,0.95)'
  for (const r of pruned) drawH(r)
  ctx.setLineDash([])
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(22,163,74,0.9)'
  for (const r of rules) drawH(r)
  ctx.strokeStyle = 'rgba(0,80,255,0.85)'
  for (const v of vrules) {
    ctx.beginPath()
    for (let y = 0; y < v.x.length; y++) (y ? ctx.lineTo(v.x[y], y) : ctx.moveTo(v.x[y], y))
    ctx.stroke()
  }
  return c.toDataURL('image/png')
}

/** Cleaned page + every CC character box (green = solid letter, orange = thin/dot). */
function charBoxesOverlay(gray: Uint8Array, W: number, H: number, chars: CCWordDebug['chars']): string {
  const c = canvasOf(grayImageData(gray, W, H))
  const ctx = c.getContext('2d')!
  ctx.lineWidth = 1
  for (const ch of chars) {
    ctx.strokeStyle = ch.skip ? 'rgba(234,88,12,0.9)' : 'rgba(22,163,74,0.9)'
    ctx.strokeRect(ch.x0 + 0.5, ch.y0 + 0.5, ch.x1 - ch.x0, ch.y1 - ch.y0)
  }
  return c.toDataURL('image/png')
}

/** Cleaned page + final word boxes, colored per line, with each line's baseline. */
function wordBoxesOverlay(
  gray: Uint8Array,
  W: number,
  H: number,
  words: CCWordDebug['words'],
  baselineByLine: Map<number, number>,
): string {
  const c = canvasOf(grayImageData(gray, W, H))
  const ctx = c.getContext('2d')!
  ctx.lineWidth = 2
  for (const w of words) {
    ctx.strokeStyle = lineColor(w.line)
    ctx.strokeRect(w.x, w.y, w.w, w.h)
  }
  ctx.strokeStyle = 'rgba(220,38,38,0.8)'
  ctx.lineWidth = 1
  for (const [line, base] of baselineByLine.entries()) {
    const some = words.some((w) => w.line === line)
    if (!some) continue
    ctx.beginPath()
    ctx.moveTo(0, base + 0.5)
    ctx.lineTo(W, base + 0.5)
    ctx.stroke()
  }
  return c.toDataURL('image/png')
}

/**
 * Crop a rectangular region of a grayscale page into a dark-on-white ImageData.
 *
 * With `mask` + `line`, every pixel the segmenter assigned to a DIFFERENT line is written
 * as paper instead — so a descender from the line above that dips into this rectangle is
 * removed while the line's own descenders (and any unclaimed ink) are kept.
 */
export function cropGrayRegion(
  gray: Uint8Array,
  W: number,
  H: number,
  x: number,
  y: number,
  w: number,
  h: number,
  mask?: Int16Array,
  line?: number,
): ImageData {
  const img = new ImageData(Math.max(1, w), Math.max(1, h))
  img.data.fill(255)
  const mine = (line ?? -1) + 1
  for (let yy = 0; yy < h; yy++) {
    const sy = y + yy
    if (sy < 0 || sy >= H) continue
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx
      if (sx < 0 || sx >= W) continue
      const si = sy * W + sx
      if (mask && mask[si] && mask[si] !== mine) continue // another line's ink → paper
      const o = (yy * w + xx) * 4
      img.data[o] = img.data[o + 1] = img.data[o + 2] = gray[si]
      img.data[o + 3] = 255
    }
  }
  return img
}

/**
 * Segment a cleaned page into WORDS the same way the editor's import does, then crop
 * each word from the rule-removed page. Fast (no WASM) — safe to re-run on every slider
 * change against a cached Pass A (`runTrainingPassA`).
 */
export function runTrainingWordSeg(cache: TrainPassA, opts?: TrainWordOptions): TrainWordResult {
  const { pa, marginRightX } = cache
  const W = pa.pageW
  const H = pa.pageH

  // Rule finder. Prefer the GRID detector — for lined paper it yields straight, evenly-
  // spaced rules that never wander up into the text (the tracer's failure mode). Fall
  // back to the editor's traced+improved rules on paper with no clear ruling. Either way
  // PRUNE any rule that still runs through the middle of a text band, so a mid-line rule
  // can't steal letters onto the wrong line.
  const grid = detectGridRules(pa.gray, W, H)
  const base = grid.length >= 2 ? grid : improveRules(pa.gray, W, H, pa.rules.rules, pa.lineHeight)
  const baseMys = base.map(ruleMedianY).sort((a, b) => a - b)
  const baseGaps: number[] = []
  for (let i = 1; i < baseMys.length; i++) baseGaps.push(baseMys[i] - baseMys[i - 1])
  baseGaps.sort((a, b) => a - b)
  let ruleLH = baseGaps.length ? baseGaps[baseGaps.length >> 1] : 0
  if (ruleLH <= 0) ruleLH = pa.lineHeight > 0 ? pa.lineHeight : Math.max(12, Math.round(H / 25))
  const rules = pruneTextCrossingRules(pa.gray, W, H, base, ruleLH)
  const pruned = base.filter((r) => !rules.includes(r)) // the text-crossing rules dropped

  const rulesJson = { ...pa.rules, rules }
  const p = passBParams.paramObject()
  const graySeg = pa.gray.slice()
  passB.removeVRules(graySeg, W, H, rulesJson, p)
  removeHRulesPage(graySeg, W, H, rules, opts?.ruleKeepDelta)

  const mys = rules.map(ruleMedianY).sort((a, b) => a - b)
  const dbg: CCWordDebug = { chars: [], words: [], lineHeight: 0, gapThreshold: 0, crossSplits: 0 }
  const lineMask = new Int16Array(W * H)
  const clean = new Uint8Array(W * H)
  const boxes = ccWordBoxes(
    graySeg,
    W,
    H,
    mys,
    marginRightX,
    { wordGap: opts?.wordGap ?? 0, gapSeparation: opts?.gapSeparation ?? 0.38, autoScale: opts?.autoScale ?? 0.7 },
    { debug: dbg, lineMask, clean },
  )
  // A word's rectangle can catch a descender hanging down from the line above; the mask
  // says which pixels are really this line's, so those intruders crop out as paper.
  const trim = opts?.trimForeignLines !== false ? lineMask : undefined
  // Crops come off the per-character cleaned + darkness-normalized page by default (one
  // ink level page-wide, no paper shading, no non-character ink). `cleanChars: false`
  // falls back to the raw rule-removed page.
  const src = opts?.cleanChars !== false ? clean : graySeg

  // Line height + the SAME baseline assignment ccWordBoxes used, so each word's
  // baseline is the rule it was grouped onto.
  const sp: number[] = []
  for (let i = 1; i < mys.length; i++) sp.push(mys[i] - mys[i - 1])
  sp.sort((a, b) => a - b)
  let lineHeight = sp.length ? sp[sp.length >> 1] : 0
  if (lineHeight <= 0) lineHeight = pa.lineHeight > 0 ? pa.lineHeight : Math.max(12, Math.round(H / 25))
  const slack = lineHeight * 0.2
  const assignLine = (y0: number, y1: number): number => {
    if (!mys.length) return 0
    const h = y1 - y0 + 1
    let rest = -1
    for (let li = 0; li < mys.length; li++) {
      if (mys[li] <= y1 + slack) rest = li
      else break
    }
    if (rest < 0) rest = 0
    while (rest + 1 < mys.length && mys[rest] < y0 + 0.1 * h) rest++
    return rest
  }

  const perLine = new Map<number, TrainWord[]>()
  for (const ln of boxes.lines) {
    for (const wb of ln.words) {
      const li = assignLine(wb.y, wb.y + wb.h - 1)
      const base = mys.length ? mys[li] : wb.y + wb.h - 1
      const gray = cropGrayRegion(src, W, H, wb.x, wb.y, wb.w, wb.h, trim, li)
      const baselineRow = Math.max(0, Math.min(wb.h - 1, Math.round(base - wb.y)))
      const arr = perLine.get(li) ?? []
      arr.push({ gray, baselineRow, x0: wb.x, y0: wb.y, x1: wb.x + wb.w - 1, y1: wb.y + wb.h - 1 })
      perLine.set(li, arr)
    }
  }
  const lineIdxs = [...perLine.keys()].sort((a, b) => a - b)
  const lines: TrainWordLine[] = lineIdxs.map((li, i) => ({
    index: i,
    rule: li,
    baselineY: mys.length ? mys[li] : 0,
    words: (perLine.get(li) ?? []).sort((a, b) => a.x0 - b.x0),
  }))
  const nWords = boxes.lines.reduce((s, l) => s + l.words.length, 0)

  // Baseline per word-line index, for the word-box overlay.
  const baselineByLine = new Map<number, number>()
  for (const w of dbg.words) if (mys[w.line] != null) baselineByLine.set(w.line, mys[w.line])
  const debug: TrainWordDebug = {
    pageW: W,
    pageH: H,
    flatRules: flatRulesOverlay(pa.flat, rules, pruned, pa.rules.vrules ?? []),
    cleaned: grayToPng(graySeg, W, H),
    charsClean: grayToPng(clean, W, H),
    charBoxes: charBoxesOverlay(graySeg, W, H, dbg.chars),
    wordBoxes: wordBoxesOverlay(graySeg, W, H, dbg.words, baselineByLine),
    stats: {
      rules: rules.length,
      rulesPruned: pruned.length,
      chars: dbg.chars.length,
      words: nWords,
      lineGroups: lines.length,
      gapThreshold: Math.round(dbg.gapThreshold * 10) / 10,
      crossSplits: dbg.crossSplits,
    },
  }
  return {
    lines,
    debug,
    stats: { rules: rules.length, words: nWords, lineGroups: lines.length },
    page: { gray: src, raw: graySeg, W, H },
    lineMask,
    ruleYs: mys,
    lineHeight,
  }
}
