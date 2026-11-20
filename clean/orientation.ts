/**
 * WHICH WAY UP IS THIS PAGE? — a quarter turn, decided from the ink.
 *
 * A phone photographs a landscape card in portrait, writes an EXIF
 * orientation, and every decoder that honours that tag (a browser's
 * `createImageBitmap`, node-canvas) hands the pipeline a page lying on its
 * side. Nothing downstream survives it: rules are traced across rows, lines
 * are cut on a row profile, baselines are rows. The failure is not subtle —
 * it is total — but it looks like a recognition problem rather than an
 * orientation one, so it costs an afternoon every time.
 *
 * The test is the oldest one in document imaging, and it needs no rules, no
 * script and no model: TEXT IS ROWS OF INK SEPARATED BY PAPER. Project the
 * ink onto the y axis and a page of writing gives a comb — dense at the
 * lines, near-empty between them; project the same page onto x and it gives a
 * plateau. Turn the page a quarter and the two swap. So the profile with the
 * deeper valleys is the reading direction.
 *
 * Which END is up is a different question and a much weaker signal (Latin
 * script has more ascenders than descenders, so a line's ink sits low in its
 * band). It is answered here only when the answer is CLEAR, because a wrong
 * 180 is worse than none: the page comes back upside down with no clue as to
 * why, where a page that is merely sideways is obvious at a glance.
 *
 * Pure geometry over a grayscale plane — no WASM, no canvas — so a caller can
 * run it on a thumbnail before deciding what to do with the full image.
 * `npm run verify:orientation` gates it on synthesized pages at all four
 * turns.
 */

export interface Orientation {
  /** Clockwise degrees the image must be turned to read it: 0, 90, 180, 270. */
  rotate: 0 | 90 | 180 | 270;
  /** How much better the chosen AXIS scored than the other (0 = a coin
   *  flip, > ~0.2 = decisive). A caller can refuse a weak verdict. */
  axisConfidence: number;
  /** …and the same for which end is up. 0 when the flip was not decided —
   *  `rotate` then names the sideways fix only. */
  flipConfidence: number;
  /** The raw scores behind the verdict, for a caller showing its working. */
  rawFlip: number;
  byRow: number;
  byCol: number;
}

const DOWNSCALE = 900;   // longest side the profiles are measured on
const MIN_AXIS = 0.06;   // below this the two axes are indistinguishable
const MIN_FLIP = 0.25;   // …and this is how sure the end-up test must be. High,
                         // because a wrong 180 is worse than none: three corpus
                         // pages voted "upside down" at 0.12-0.22 and were not.

/**
 * Ink coverage per row (or column) — MEASURED ONLY ON THE PAPER.
 *
 * A photographed card is a bright rectangle on a dark floor, and the floor is
 * darker than the ink. Counted naively, every row and every column is "fully
 * inked", both profiles are flat, and the page reports no orientation at all
 * (measured: axis confidence 0.000 on both test cards, against 0.324 on a
 * page-filling scan). So each line is trimmed to the paper it crosses — the
 * first and last paper-bright pixel on that line — and the ink is counted, and
 * normalised, inside that span alone. On a scan the span is the whole line and
 * nothing changes; on a card it is the card.
 */
function inkProfile(gray: Uint8Array, w: number, h: number, byRow: boolean): Float64Array {
  // Paper = the 85th percentile of a sparse sample; ink is meaningfully darker.
  const samp: number[] = [];
  for (let i = 0; i < w * h; i += 97) samp.push(gray[i]);
  samp.sort((a, b) => a - b);
  const paper = samp[Math.floor(samp.length * 0.85)] ?? 235;
  const dark = paper - 32;
  const bright = paper - 45;   // still paper, allowing for shadow across a page
  const n = byRow ? h : w;
  const across = byRow ? w : h;
  const out = new Float64Array(n);
  const at = (i: number, j: number) => (byRow ? i * w + j : j * w + i);
  for (let i = 0; i < n; i++) {
    let a = -1, b = -1;
    for (let j = 0; j < across; j++) if (gray[at(i, j)] >= bright) { if (a < 0) a = j; b = j; }
    if (a < 0 || b - a < across * 0.1) continue;   // no paper worth measuring here
    let ink = 0;
    for (let j = a; j <= b; j++) if (gray[at(i, j)] < dark) ink++;
    out[i] = ink / (b - a + 1);
  }
  return out;
}

/**
 * How much this profile looks like LINES OF TEXT rather than a wash: the
 * share of the inked extent that is nearly empty. Rows of writing leave real
 * gutters between them; the same ink projected along the writing direction
 * leaves none.
 */
function combScore(p: Float64Array): number {
  let lo = 0, hi = p.length - 1;
  while (lo < p.length && p[lo] <= 0.002) lo++;
  while (hi > lo && p[hi] <= 0.002) hi--;
  const n = hi - lo + 1;
  if (n < 16) return 0;
  let peak = 0;
  for (let i = lo; i <= hi; i++) if (p[i] > peak) peak = p[i];
  if (peak <= 0) return 0;
  // "Nearly empty" is relative to the page's own busiest row: a light hand
  // and a heavy one give the same comb.
  const floor = peak * 0.12;
  let empty = 0;
  for (let i = lo; i <= hi; i++) if (p[i] <= floor) empty++;
  return empty / n;
}

/** The inked bands of a profile — a line of writing, or a column of words. */
function bandsOf(p: Float64Array): [number, number][] {
  let peak = 0;
  for (let i = 0; i < p.length; i++) if (p[i] > peak) peak = p[i];
  const bands: [number, number][] = [];
  if (peak <= 0) return bands;
  const on = peak * 0.12;
  let start = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > on) { if (start < 0) start = i; }
    else if (start >= 0) { if (i - start >= 4) bands.push([start, i - 1]); start = -1; }
  }
  if (start >= 0 && p.length - start >= 4) bands.push([start, p.length - 1]);
  return bands;
}

/**
 * WHICH END OF THE LINES IS THEIR START. Writing is left-aligned and ragged
 * right: every line begins at the margin and stops where the words ran out,
 * so the ink projected ALONG the writing direction is heavy at the start and
 * thins toward the end. Turn the page 180° and that asymmetry reverses.
 *
 * This is the stronger of the two end-up tests by a long way — the
 * ascender/descender one below needs many lines to average out, and a card
 * with nine short items does not have them (measured: ±0.03 on both test
 * cards, against a decisive 0.42 on a full page of prose). Returns the share
 * of the ink mass in the first half of the inked span, minus a half: positive
 * = the lines start at the low end of this axis.
 */
function alignScore(p: Float64Array): number {
  let lo = 0, hi = p.length - 1;
  while (lo < p.length && p[lo] <= 0.002) lo++;
  while (hi > lo && p[hi] <= 0.002) hi--;
  if (hi - lo < 16) return 0;
  let total = 0, first = 0;
  const mid = (lo + hi) / 2;
  for (let i = lo; i <= hi; i++) { total += p[i]; if (i <= mid) first += p[i]; }
  return total > 0 ? first / total - 0.5 : 0;
}

/**
 * Is the writing the right way UP? A line of Latin script fills the band
 * between its ascender tops and its baseline, and leaves the descender space
 * below mostly empty — so within each inked band the ink's centre of mass
 * sits BELOW the middle. Upside down it sits above. Returns the share of
 * bands that agree, minus a half (so 0 = no idea, +0.5 = every band agrees).
 */
function uprightScore(p: Float64Array): number {
  const bands = bandsOf(p);
  if (bands.length < 2) return 0;
  let low = 0;
  for (const [a, b] of bands) {
    let sum = 0, wsum = 0;
    for (let i = a; i <= b; i++) { sum += p[i]; wsum += p[i] * (i - a); }
    if (!sum) continue;
    // centre of mass as a fraction of the band's height
    if (wsum / sum / (b - a) > 0.5) low++;
  }
  return low / bands.length - 0.5;
}

/** Downscale by simple box averaging — the profiles only need the shape. */
function shrink(gray: Uint8Array, w: number, h: number): { g: Uint8Array; w: number; h: number } {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / DOWNSCALE));
  if (step === 1) return { g: gray, w, h };
  const nw = Math.floor(w / step), nh = Math.floor(h / step);
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let min = 255;
      for (let dy = 0; dy < step; dy++) {
        const row = (y * step + dy) * w + x * step;
        for (let dx = 0; dx < step; dx++) {
          const v = gray[row + dx];
          if (v < min) min = v;   // keep the ink: a min-filter, not a blur
        }
      }
      out[y * nw + x] = min;
    }
  }
  return { g: out, w: nw, h: nh };
}

/** RGBA → gray, for callers holding an ImageData buffer. */
export function grayOf(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
  }
  return g;
}

export function detectOrientation(gray: Uint8Array, w: number, h: number): Orientation {
  const s = shrink(gray, w, h);
  const rows = inkProfile(s.g, s.w, s.h, true);
  const cols = inkProfile(s.g, s.w, s.h, false);
  const byRow = combScore(rows);
  const byCol = combScore(cols);
  const axisConfidence = Math.abs(byRow - byCol);
  // The profile ACROSS the writing is the combed one. If the columns comb,
  // the page is lying on its side.
  const sideways = byCol > byRow && axisConfidence >= MIN_AXIS;
  // ACROSS the writing is the combed profile; ALONG it is the other one, and
  // that is where both end-up tests read.
  const across = sideways ? cols : rows;
  const along = sideways ? rows : cols;
  const start = alignScore(along);      // do the lines start at the low end?
  const rested = uprightScore(across);  // does each line's ink sit low in its band?
  // The two answer the same question from different evidence, so they vote
  // together — weighted, because the margin is a hard edge on every page while
  // the ascender/descender balance is a tendency that needs many lines.
  //
  // THE SECOND VOTE FLIPS SIGN ON A SIDEWAYS PAGE. A quarter turn reverses the
  // handedness between the two axes: turned 90° clockwise, a page's line
  // starts land at the TOP (low index along) while the ink that rested LOW in
  // each band now sits at LOW index across. Read with one sign for both, the
  // votes cancel and a page turned a quarter comes back turned three (the gate
  // caught exactly that).
  const upright = start * 2 + (sideways ? -rested : rested);
  const flipConfidence = Math.abs(upright) >= MIN_FLIP ? Math.min(1, Math.abs(upright)) : 0;
  const startsLow = upright >= 0;

  // Turning the IMAGE clockwise by `rotate` must put the writing upright.
  // A page turned 90° CW puts the line starts at its TOP (low row index), and
  // needs 270° back; one turned 270° CW puts them at its bottom.
  //
  // A SIDEWAYS page must be turned one way or the other, so the sign of the
  // vote is taken however weak it is — being upside down is a nuisance, being
  // sideways is unreadable. An upright one is only turned over when the vote
  // is CONFIDENT: three corpus pages voted "upside down" at 0.12-0.22 and were
  // not, and a page needlessly flipped is a page nobody can explain.
  let rotate: Orientation['rotate'] = 0;
  if (sideways) rotate = startsLow ? 270 : 90;
  else if (flipConfidence > 0 && !startsLow) rotate = 180;
  return { rotate, axisConfidence, flipConfidence, rawFlip: upright, byRow, byCol };
}

/** Rotate an RGBA buffer clockwise by 0/90/180/270 — the turn `detectOrientation`
 *  names, applied. */
export function rotateRgba(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  deg: 0 | 90 | 180 | 270,
): { rgba: Uint8ClampedArray; w: number; h: number } {
  if (deg === 0) return { rgba, w, h };
  const turned = deg === 180 ? { w, h } : { w: h, h: w };
  const out = new Uint8ClampedArray(turned.w * turned.h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const nx = deg === 90 ? h - 1 - y : deg === 180 ? w - 1 - x : y;
      const ny = deg === 90 ? x : deg === 180 ? h - 1 - y : w - 1 - x;
      const dst = (ny * turned.w + nx) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return { rgba: out, w: turned.w, h: turned.h };
}
