// Left-margin handling for the grayscale pipeline.
//
// The editor historically found the margin from the RED vertical rule. Under the
// grayscale pipeline there's no colour to key on, so we locate the margin from
// Pass A's traced VERTICAL rule (vrule), then run the editor's EXISTING glyph
// classifier on the strip left of it — the classifier works on a binary mask
// and is colour-agnostic, so only the line-finding + strip extraction change.

import type { PassAResult } from './passADriver';
import type { RulesJson } from './types';
import type { MarginMark, MarginKind } from './types';
import { classifyGlyphContours, type MarginSymbol } from './marginRecognition';

// Same thresholds as the v1 color pipeline (px scale is comparable).
const MIN_GLYPH_EXTENT = 10; // discard specks (longer bbox side < this)
const MIN_GLYPH_WIDTH = 20;  // discard slivers
const MIN_AREA = 8;
// A wide margin box is EITHER a run of '#' or a dash; width alone can't decide,
// so the tiebreaker is HEIGHT (fractions of the line height): a '#' fills a good
// part of the line while a dash is only a stroke thick.
const HASH_MIN_FRAC = 0.2;  // attempt the multi-# split above this height
const HASH_TALL_FRAC = 0.32; // too tall to be a dash: a majority of '#' slices wins

export interface MarginLine {
  /** Vertical-rule x (flat-page px); -1 if no margin. */
  marginX: number;
  /** X to the right of which real words live (strip exclusion for segmentation).
   *  0 when the margin is on the right, or absent. */
  marginRightX: number;
  /** For a RIGHT-hand margin: X to the LEFT of which real words live. 0 when
   *  the margin is on the left, or absent. */
  marginLeftX: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Locate the margin from Pass A's vertical rules: the leftmost vrule in the
 * left ~35% of the page (the editor's historical limit) — or, for a right-hand
 * margin (`side: 'right'`), the rightmost vrule in the right 35%. Cheap;
 * called before segmentation so the strip can be excluded from word detection.
 */
export function detectMarginLine(pa: PassAResult, side: 'left' | 'right' = 'left'): MarginLine {
  const vrules = pa.rules.vrules ?? [];
  const none: MarginLine = { marginX: -1, marginRightX: 0, marginLeftX: 0 };
  let marginX = -1;
  let marginThick = 0;
  if (side === 'right') {
    const rightLimit = pa.pageW * 0.65;
    for (const v of vrules) {
      const x = median(v.x);
      if (x >= rightLimit && x < pa.pageW && (marginX < 0 || x > marginX)) {
        marginX = x;
        marginThick = v.thickness;
      }
    }
    if (marginX < 0) return none;
    return { marginX, marginRightX: 0, marginLeftX: Math.round(marginX - marginThick / 2 - 4) };
  }
  const leftLimit = pa.pageW * 0.35;
  for (const v of vrules) {
    const x = median(v.x);
    if (x >= 0 && x <= leftLimit && (marginX < 0 || x < marginX)) {
      marginX = x;
      marginThick = v.thickness;
    }
  }
  if (marginX < 0) return none;
  return { marginX, marginRightX: Math.round(marginX + marginThick / 2 + 4), marginLeftX: 0 };
}

/** Otsu threshold over the margin strip [stripLeft, stripRight). */
function otsuStrip(gray: Uint8Array, W: number, H: number, stripRight: number, stripLeft = 0): number {
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let y = 0; y < H; y++)
    for (let x = stripLeft; x < stripRight; x++) { hist[gray[y * W + x]]++; total++; }
  if (!total) return 128;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return thr;
}

interface Comp { x0: number; y0: number; x1: number; y1: number; area: number }

/** Column ranges of ink in a mask, separated by empty-column gaps >= minGap.
 *  Used to split a wide margin box (e.g. a horizontal "## ") into its symbols. */
function columnSegments(mask: Uint8Array, w: number, h: number, minGap: number): [number, number][] {
  const colInk = new Array(w).fill(0);
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) if (mask[y * w + x]) colInk[x]++;
  const segs: [number, number][] = [];
  let start = -1, end = -1, gap = 0;
  for (let x = 0; x < w; x++) {
    if (colInk[x] > 0) { if (start < 0) start = x; end = x; gap = 0; }
    else if (start >= 0) { gap++; if (gap >= minGap) { segs.push([start, end]); start = -1; } }
  }
  if (start >= 0) segs.push([start, end]);
  return segs;
}

/** 8-connected components of ink (bin==1) within the strip [stripLeft, stripRight). */
function components(bin: Uint8Array, W: number, H: number, stripRight: number, stripLeft = 0): Comp[] {
  const seen = new Uint8Array(W * H);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = stripLeft; x < stripRight; x++) {
      const start = y * W + x;
      if (!bin[start] || seen[start]) continue;
      seen[start] = 1;
      stack.length = 0;
      stack.push(start);
      let x0 = x, y0 = y, x1 = x, y1 = y, area = 0;
      while (stack.length) {
        const i = stack.pop()!;
        const cx = i % W, cy = (i / W) | 0;
        area++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < stripLeft || nx >= stripRight || ny < 0 || ny >= H) continue;
            const j = ny * W + nx;
            if (bin[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
          }
        }
      }
      comps.push({ x0, y0, x1, y1, area });
    }
  }
  return comps;
}

const KIND: Partial<Record<MarginSymbol, MarginKind>> = {
  '-': 'bullet',
  '1': 'ordered',
  '>': 'blockquote',
  '?': 'linebreak',
};

/**
 * Classify the glyphs in the margin strip and emit MarginMark[] keyed to word
 * lines. Mirrors the v1 pipeline (component extraction → per-line clustering →
 * classify → marginMarksFrom) but on the grayscale strip. Runs after the word
 * baselines are known so glyphs can be matched to lines.
 */
export function classifyMarginGlyphs(
  gray: Uint8Array, W: number, H: number, rulesJson: RulesJson,
  marginX: number,
  lines: { line: number; baselineY: number }[], // segmenter line + its baseline
  lineHeight: number,
  /** Which side of the rule the strip is on: the page's left edge up to the
   *  rule (default), or the rule out to the right edge for a right-hand margin. */
  side: 'left' | 'right' = 'left',
): MarginMark[] {
  if (marginX <= 1 || !lines.length) return [];
  // the strip [stripLeft, stripRight), a couple of px clear of the rule
  const stripLeft = side === 'right' ? Math.min(W - 1, Math.round(marginX) + 2) : 0;
  const stripRight = side === 'right' ? W : Math.max(1, Math.round(marginX) - 2);
  if (stripRight - stripLeft < 2) return [];
  const lh = lineHeight > 0 ? lineHeight : H / 25;

  // Build the strip's ink mask, but EXCLUDE horizontal-rule bands: the printed
  // rules run through the margin and their left ends otherwise read as dashes,
  // marking every ruled line as a bullet. (In the old color pipeline the blue
  // rules were dropped by hue; grayscale rules are just ink, so mask them here.)
  const rules = rulesJson.rules;
  const onHRule = (x: number, y: number): boolean => {
    for (const r of rules) {
      if (x >= r.y.length) continue;
      if (Math.abs(y - r.y[x]) <= r.thickness / 2 + 2) return true;
    }
    return false;
  };

  const thr = otsuStrip(gray, W, H, stripRight, stripLeft);
  const bin = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = stripLeft; x < stripRight; x++)
      if (gray[y * W + x] < thr && !onHRule(x, y)) bin[y * W + x] = 1;

  // A component that TOUCHES the strip's right boundary continues into the text
  // zone — it is the first letter of the line poking across the margin rule,
  // not a symbol. Measured: an "All" written starting on the rule put the A's
  // left leg in the strip, which classified as '1' and turned the line into an
  // ordered list. Real margin symbols are written inside the strip with
  // clearance from the rule.
  // ...and "touches" needs CLEARANCE, not adjacency: removeVRules erases the
  // rule band straight through a crossing letter, so the letter's strip-side
  // piece can end a pixel or two short of the boundary (measured: the A's leg
  // at x1 = stripRight - 2 on one decode of the same photo). A real margin
  // symbol is written inside the strip, several px clear of the rule.
  // (mirrored for a right-hand strip: a component that reaches the strip's
  // LEFT boundary is the last letter of the line poking across the rule)
  const comps = components(bin, W, H, stripRight, stripLeft)
    .filter((c) => c.area >= MIN_AREA && (side === 'right' ? c.x0 >= stripLeft + 6 : c.x1 < stripRight - 6));
  if (!comps.length) return [];

  // Cluster components into glyphs: group into line-bands by y, then split each
  // band into side-by-side glyphs by x-gaps.
  comps.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const bands: Comp[][] = [];
  for (const c of comps) {
    const cy = (c.y0 + c.y1) / 2;
    const last = bands[bands.length - 1];
    if (last) {
      const ly = (last[last.length - 1].y0 + last[last.length - 1].y1) / 2;
      if (Math.abs(cy - ly) <= lh * 0.6) { last.push(c); continue; }
    }
    bands.push([c]);
  }

  interface Glyph { x0: number; y0: number; x1: number; y1: number; sym: MarginSymbol }
  const glyphs: Glyph[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x0 - b.x0);
    let cluster: Comp[] = [];
    const flush = () => {
      if (!cluster.length) return;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (const c of cluster) {
        x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0);
        x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1);
      }
      cluster = [];
      const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
      if (Math.max(gw, gh) < MIN_GLYPH_EXTENT || gw < MIN_GLYPH_WIDTH) return;
      const mask = new Uint8Array(gw * gh);
      for (let yy = 0; yy < gh; yy++)
        for (let xx = 0; xx < gw; xx++)
          mask[yy * gw + xx] = bin[(y0 + yy) * W + (x0 + xx)];

      // Multi-# heading split (## = H2, ### = H3) vs a bullet DASH — both are
      // WIDE boxes, so width alone must not decide (a whole-box classification
      // of '###' matches the dash template on aspect). Split the box into
      // column segments and classify each slice. A '#' run's slices misread
      // individually far more often than anything else reads as '#', so a box
      // too tall to be a dash (≥ HASH_TALL_FRAC of the line) commits on ANY
      // '#' slice — '####' with two bad slices no longer misfiles as '-'. A
      // shorter box (dash-plausible) needs a strict MAJORITY, so a sliced dash
      // whose one squarish chunk misreads as '#' doesn't become a heading.
      // Boxes under HASH_MIN_FRAC are never split.
      if (gh >= lh * HASH_MIN_FRAC && gw / gh >= 1.5) {
        let segs = columnSegments(mask, gw, gh, Math.max(2, Math.round(gh * 0.2)));
        if (segs.length < 2) {
          // touching hashes (no clear gap): slice equally, count ≈ aspect ratio
          const n = Math.min(4, Math.max(2, Math.round(gw / gh)));
          segs = [];
          for (let k = 0; k < n; k++)
            segs.push([Math.round((k * gw) / n), Math.round(((k + 1) * gw) / n) - 1]);
        }
        if (segs.length >= 2) {
          const parts = segs.map(([sx0, sx1]) => {
            const sw = sx1 - sx0 + 1;
            const sub = new Uint8Array(sw * gh);
            for (let yy = 0; yy < gh; yy++)
              for (let xx = 0; xx < sw; xx++) sub[yy * sw + xx] = mask[yy * gw + (sx0 + xx)];
            return { sx0, sx1, sym: classifyGlyphContours(sub, sw, gh).best };
          });
          const hashes = parts.filter((pt) => pt.sym === '#').length;
          const commit =
            gh >= lh * HASH_TALL_FRAC ? hashes > 0 : hashes * 2 > parts.length;
          if (commit) {
            for (const pt of parts)
              glyphs.push({ x0: x0 + pt.sx0, y0, x1: x0 + pt.sx1, y1, sym: '#' });
            return;
          }
        }
      }

      const cl = classifyGlyphContours(mask, gw, gh);
      glyphs.push({ x0, y0, x1, y1, sym: cl.best });
    };
    let prev: Comp | null = null;
    for (const c of band) {
      if (prev && c.x0 - prev.x1 >= lh * 0.45) flush();
      cluster.push(c);
      prev = c;
    }
    flush();
  }

  // marginMarksFrom: match each glyph to the nearest word-line baseline, group,
  // then map symbols to a MarginKind ('#' count → heading level).
  const byLine = new Map<number, MarginSymbol[]>();
  for (const g of glyphs) {
    const cy = (g.y0 + g.y1) / 2;
    let bestLine = -1, bestD = Infinity;
    for (const ln of lines) {
      const d = Math.abs(cy - ln.baselineY);
      if (d < bestD) { bestD = d; bestLine = ln.line; }
    }
    if (bestLine < 0 || bestD > lh * 0.8) continue;
    if (!byLine.has(bestLine)) byLine.set(bestLine, []);
    byLine.get(bestLine)!.push(g.sym);
  }

  const marks: MarginMark[] = [];
  for (const [line, syms] of byLine) {
    const hashes = syms.filter((s) => s === '#').length;
    if (hashes > 0) {
      // Any '#' on the line ⇒ the whole mark is a run of hashes (headings are
      // the only multi-glyph symbol), so EVERY glyph counts toward the level.
      marks.push({ line, kind: 'heading', level: Math.min(syms.length, 4) });
      continue;
    }
    const kind = KIND[syms[0]];
    if (kind) marks.push({ line, kind });
  }
  return marks;
}
