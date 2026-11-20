/**
 * Page-corner CANDIDATES, in TypeScript, beside the WASM detector.
 *
 * The shipped detector (clean/wasm/src/global/page_detect.c) is one approach:
 * bright-mask -> hull -> max-area quad -> per-side snap. It fails in ways the
 * user sees directly in the import preview — a shadowed edge eats a side, a
 * bright table merges with the paper, a close-up loses every corner. This
 * module adds two INDEPENDENT approaches so the labs can show several
 * possibilities and `scripts/edgescore.mjs` can score all of them against
 * hand-annotated corners (/edgelab.html):
 *
 *   'rules'  — find the RULED STRUCTURE first. Printed rules are the most
 *              reliable thing on a notebook photo: a sheared row-projection
 *              sweep finds their slope and rows (the ruleSlopeSwing idea from
 *              index.ts), their x-extents bound the writing area, and the page
 *              edge is then the strongest OUTWARD intensity step beyond that
 *              box, one robust line fit per side. A shadow inside the page
 *              does not stop the search because the scan keeps going and the
 *              OUTERMOST strong step wins; a side with no step before the
 *              frame clamps to the frame (the sheet runs past the picture on
 *              that side).
 *   'border' — rule-free: per side, march scanlines inward from the frame
 *              until a SUSTAINED paper-bright run starts, then fit a line
 *              through those first-paper points with outlier rejection. This
 *              is the bright-mask idea rebuilt as per-scanline evidence + a
 *              robust fit, so one thumb or shadow spur moves its own samples
 *              and not the hull.
 *
 * Both report in ORIGINAL photo pixels (TL,TR,BR,BL) with a 0..1 score — the
 * mean normalized intensity step under the fitted sides, the same quantity as
 * the WASM `quadScore` — plus per-side `snapped` flags so a frame-clamped side
 * is legible. Nothing here changes the pipeline: cleanPage attaches the list
 * for the labs, and `quadPick: 'auto'` (off by default) is the switch a
 * MEASURED comparison can flip once edge labels exist.
 */

export interface QuadCandidate {
  method: 'rules' | 'border' | 'fused';
  /** TL,TR,BR,BL in ORIGINAL photo pixels. */
  quad: number[];
  /** Mean normalized edge step under the fitted sides, 0..1. Frame-clamped
   *  sides contribute nothing (they have no paper edge to measure). */
  score: number;
  /** Per side (top,right,bottom,left): true = a real edge was fitted,
   *  false = clamped to the image frame. */
  snapped: boolean[];
  /** Per side, the normalized step strength under the fitted line (0 for a
   *  frame-clamped side) — what the 'fused' candidate picks sides by. */
  sideScores: number[];
  note?: string;
  /** internal: the four fitted full-resolution side lines, for the fusion */
  _lines?: unknown;
}

type Line = { a: number; b: number; c: number };  // ax + by = c, |a,b| = 1

const lineThrough = (x0: number, y0: number, x1: number, y1: number): Line => {
  let a = y1 - y0, b = x0 - x1;
  const n = Math.hypot(a, b) || 1;
  a /= n; b /= n;
  return { a, b, c: a * x0 + b * y0 };
};
const intersect = (p: Line, q: Line): [number, number] | null => {
  const d = p.a * q.b - q.a * p.b;
  if (Math.abs(d) < 1e-9) return null;
  return [(p.c * q.b - q.c * p.b) / d, (p.a * q.c - q.a * p.c) / d];
};

/** Least-squares line through points, iteratively dropping outliers. Returns
 *  null when fewer than minFrac of the points survive — a side that ragged is
 *  not an edge. */
function robustLine(pts: Array<[number, number]>, minFrac = 0.55): Line | null {
  let keep = pts.slice();
  for (let round = 0; round < 3; round++) {
    if (keep.length < 4) return null;
    // fit by principal direction (works for near-vertical sides too)
    let mx = 0, my = 0;
    for (const [x, y] of keep) { mx += x; my += y; }
    mx /= keep.length; my /= keep.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of keep) {
      const dx = x - mx, dy = y - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const t = Math.atan2(2 * sxy, sxx - syy) / 2;   // principal axis angle
    const a = -Math.sin(t), b = Math.cos(t);        // normal to it
    const c = a * mx + b * my;
    const res = keep.map(([x, y]) => Math.abs(a * x + b * y - c));
    const sd = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length) || 1e-6;
    const next = keep.filter((_, i) => res[i] <= Math.max(2.5 * sd, 1.5));
    if (next.length === keep.length || next.length < pts.length * minFrac) {
      if (next.length < pts.length * minFrac) return null;
      return { a, b, c };
    }
    keep = next;
  }
  return null;
}

function quadOk(q: number[], w: number, h: number): boolean {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    area += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  if (Math.abs(area) / 2 < 0.15 * w * h) return false;
  for (let i = 0; i < 4; i++) {
    const p = (i + 3) & 3, n = (i + 1) & 3;
    const ax = q[p * 2] - q[i * 2], ay = q[p * 2 + 1] - q[i * 2 + 1];
    const bx = q[n * 2] - q[i * 2], by = q[n * 2 + 1] - q[i * 2 + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 2 || lb < 2) return false;
    const deg = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 57.2958;
    if (deg < 45 || deg > 135) return false;
  }
  return true;
}

const pct = (g: Uint8Array, p: number): number => {
  const s: number[] = [];
  for (let i = 0; i < g.length; i += 499) s.push(g[i]);
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length * p)] ?? 200;
};

/** Luma of one photo pixel — the one formula, used lazily at full resolution
 *  (the refine and score steps sample a few hundred points; materialising a
 *  12-megapixel luma plane for them was a third of this file's cost). */
const lumaAt = (rgba: Uint8ClampedArray, w: number) => (x: number, y: number): number => {
  const p = (y * w + x) * 4;
  return (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
};

/** Luma + box-downscale to a working long edge.
 *
 *  ONE PASS over the photo in row order: each source row's luma is added into
 *  its output column's accumulator, and a block is emitted when its last
 *  source row has been read. The block partition (which source pixels feed
 *  which output pixel) is the original per-output-pixel one, tabulated —
 *  integer sums in any order are the same integer, so the result is exact. */
function toGray(rgba: Uint8ClampedArray, w: number, h: number, maxDim: number):
    { g: Uint8Array; gw: number; gh: number; scale: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const gw = Math.max(8, Math.round(w * scale)), gh = Math.max(8, Math.round(h * scale));
  const g = new Uint8Array(gw * gh);
  const inv = 1 / scale;
  // the partition: source column -> output column (-1 = feeds none), and the
  // block bounds per output row/column
  const colOf = new Int32Array(w).fill(-1);
  const colN = new Int32Array(gw);
  for (let x = 0; x < gw; x++) {
    const x0 = Math.floor(x * inv), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * inv)));
    for (let xx = x0; xx < x1; xx++) colOf[xx] = x;
    colN[x] = x1 - x0;
  }
  const acc = new Int32Array(gw);
  for (let y = 0; y < gh; y++) {
    const y0 = Math.floor(y * inv), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * inv)));
    acc.fill(0);
    for (let yy = y0; yy < y1; yy++) {
      let i = yy * w * 4;
      for (let xx = 0; xx < w; xx++, i += 4) {
        const c = colOf[xx];
        if (c < 0) continue;
        acc[c] += (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
      }
    }
    const rows = y1 - y0;
    for (let x = 0; x < gw; x++) {
      const n = rows * colN[x];
      g[y * gw + x] = n ? Math.round(acc[x] / n) : 255;
    }
  }
  return { g, gw, gh, scale };
}

/**
 * The strongest OUTWARD paper edge along one scanline.
 *
 * Walk from `from` toward `to` (either axis, either direction) and score each
 * position by mean(inside window) - mean(outside window); the paper edge is
 * where inside is paper-bright and outside is not. The OUTERMOST position
 * within `minStep` of the best keeps a shadow strip inside the page from
 * stealing the edge: the true edge is at least as strong and further out.
 * Returns the coordinate along the scan axis, or null.
 */
function outermostStep(sample: (t: number) => number, from: number, to: number, minStep: number):
    number | null {
  const dir = to > from ? 1 : -1, n = Math.abs(to - from);
  if (n < 8) return null;
  const WIN = 4;
  let bestV = 0;
  const steps: Array<{ t: number; v: number }> = [];
  for (let k = WIN; k < n - WIN; k++) {
    const t = from + k * dir;
    let inside = 0, outside = 0;
    for (let j = 1; j <= WIN; j++) {
      inside += sample(t - j * dir);   // toward `from` = the page interior
      outside += sample(t + j * dir);  // toward `to` = past the edge
    }
    const v = (inside - outside) / WIN;
    if (v > bestV) bestV = v;
    if (v >= minStep) steps.push({ t, v });
  }
  if (!steps.length || bestV < minStep) return null;
  // outermost survivor within 70% of the strongest…
  const bar = Math.max(minStep, bestV * 0.7);
  const cands = steps.filter((s) => s.v >= bar)
    .sort((a, b) => Math.abs(a.t - to) - Math.abs(b.t - to));
  // …that also VALIDATES as a page edge. Two impostors fit convincing lines
  // without this (both found on the first annotated corpus):
  //  - a PRINTED LINE (the red margin rule) — paper on BOTH sides, so the
  //    darkness must be SUSTAINED past the step, not a dip;
  //  - a SHADOW's inner boundary — dark outside all right, but a soft RAMP,
  //    where a paper edge is a sharp step. v at a tight window collapses on a
  //    ramp and holds on an edge.
  for (const c of cands) {
    const t = c.t;
    let far = 0, fc = 0;
    for (let j = 6; j <= 16; j++) {
      const tt = t + j * dir;
      if ((dir > 0 && tt > Math.max(from, to)) || (dir < 0 && tt < Math.min(from, to))) break;
      far += sample(tt); fc++;
    }
    let inside2 = 0, near2 = 0;
    for (let j = 1; j <= 2; j++) { inside2 += sample(t - j * dir); near2 += sample(t + j * dir); }
    const vTight = (inside2 - near2) / 2;
    const insideM = c.v + (near2 / 2);         // ≈ inside mean at this point
    const sustained = fc < 4                    // ran off the frame: nothing to test
      || (far / fc) < insideM - minStep * 0.75;
    const sharp = vTight >= c.v * 0.5;
    if (sustained && sharp) return t;
  }
  return null;
}

/** Score a fitted quad the way the WASM does: mean normalized step across its
 *  sides, sampled on the FULL-resolution gray. Frame-clamped sides are skipped. */
function scoreQuad(lum: (x: number, y: number) => number, w: number, h: number, q: number[], snapped: boolean[],
    contrast: number): { score: number; sides: number[] } {
  let tot = 0, n = 0;
  const sides = [0, 0, 0, 0];
  for (let side = 0; side < 4; side++) {
    if (!snapped[side]) continue;
    const i = side, j = (side + 1) & 3;
    const x0 = q[i * 2], y0 = q[i * 2 + 1], x1 = q[j * 2], y1 = q[j * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = (y1 - y0) / len, ny = -(x1 - x0) / len;   // one normal
    const D = Math.max(3, Math.round(Math.min(w, h) * 0.006));
    let s = 0, c = 0;
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      const xa = Math.round(x + nx * D), ya = Math.round(y + ny * D);
      const xb = Math.round(x - nx * D), yb = Math.round(y - ny * D);
      if (xa < 0 || ya < 0 || xa >= w || ya >= h || xb < 0 || yb < 0 || xb >= w || yb >= h) continue;
      s += Math.abs(lum(xa, ya) - lum(xb, yb));
      c++;
    }
    if (c >= 8) { sides[side] = Math.min(1, (s / c) / contrast); tot += sides[side]; n++; }
  }
  return { score: n ? Math.min(1, tot / n) : 0, sides };
}

/** Refit one side at FULL resolution: sample points on the coarse line, snap
 *  each along the side's normal to the strongest step within `band` px. */
function refineSide(lum: (x: number, y: number) => number, w: number, h: number, line: Line,
    tRange: [number, number, number, number], band: number, minStep: number): Line {
  // two points on the line spanning the quad region
  const [px0, py0, px1, py1] = tRange;
  const pts: Array<[number, number]> = [];
  for (let k = 1; k < 20; k++) {
    const t = k / 20;
    const x = px0 + (px1 - px0) * t, y = py0 + (py1 - py0) * t;
    let best = 0, bestD = 0;
    for (let d = -band; d <= band; d++) {
      const xi = Math.round(x + line.a * (d - 3)), yi = Math.round(y + line.b * (d - 3));
      const xo = Math.round(x + line.a * (d + 3)), yo = Math.round(y + line.b * (d + 3));
      if (xi < 0 || yi < 0 || xi >= w || yi >= h || xo < 0 || yo < 0 || xo >= w || yo >= h) continue;
      const v = Math.abs(lum(xi, yi) - lum(xo, yo));
      if (v > best) { best = v; bestD = d; }
    }
    if (best >= minStep) pts.push([x + line.a * bestD, y + line.b * bestD]);
  }
  return robustLine(pts, 0.4) ?? line;
}

/** Order 4 corner points TL,TR,BR,BL (the same upright assumption as the WASM). */
function orderQuad(cs: Array<[number, number]>): number[] {
  const bySum = cs.slice().sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
  const tl = bySum[0], br = bySum[3];
  const byDiff = cs.slice().sort((p, q) => (p[0] - p[1]) - (q[0] - q[1]));
  const bl = byDiff[0], tr = byDiff[3];
  return [tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]];
}

export function quadCandidates(rgba: Uint8ClampedArray, w: number, h: number): QuadCandidate[] {
  const full = lumaAt(rgba, w);
  const { g, gw, gh, scale } = toGray(rgba, w, h, 560);
  const paper = pct(g, 0.85);
  const dark = pct(g, 0.05);
  const contrast = Math.max(30, paper - dark);
  const minStep = Math.max(14, contrast * 0.22);
  const out: QuadCandidate[] = [];

  const rules = rulesCandidate(g, gw, gh, paper, minStep);
  if (rules) out.push(finish('rules', rules));
  const border = borderCandidate(g, gw, gh, paper, minStep);
  if (border) out.push(finish('border', border));

  // FUSED: the methods fail on different sides (measured on the first
  // annotated corpus: rules carried page-e/b/c, border carried doubledia/
  // page-d), and sides are independent lines — so pick each side from
  // whichever method fitted it with the strongest evidence, frame where
  // nobody did. This is evidence-per-side, not a page-level vote, so it
  // cannot overfit to any one corpus's layout.
  {
    const frameF: Line[] = [
      { a: 0, b: 1, c: 0 }, { a: 1, b: 0, c: w - 1 },
      { a: 0, b: 1, c: h - 1 }, { a: 1, b: 0, c: 0 },
    ];
    const lines: Line[] = frameF.slice();
    const snapped = [false, false, false, false];
    const sideScores = [0, 0, 0, 0];
    // How many methods fitted each side: a LONE fit overriding everyone
    // else's frame-clamp needs STRONG evidence (a real paper edge saturates
    // the step score; page-c's shadow boundary sat at 0.43 while its real
    // edge scored 1.00), while agreement between methods lowers the bar.
    const fittedBy = [0, 0, 0, 0];
    for (const cd of out) for (let i = 0; i < 4; i++) if (cd.snapped[i]) fittedBy[i]++;
    for (const cd of out) {
      const cls = cd._lines as Line[] | undefined;
      if (!cls) continue;
      for (let side = 0; side < 4; side++) {
        const bar = fittedBy[side] >= 2 ? 0.25 : 0.55;
        if (cd.snapped[side] && cd.sideScores[side] >= bar
          && cd.sideScores[side] > sideScores[side]) {
          lines[side] = cls[side];
          snapped[side] = true;
          sideScores[side] = cd.sideScores[side];
        }
      }
    }
    const cs: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) {
      const c2 = intersect(lines[i], lines[(i + 3) & 3]);
      cs.push(c2 ? [Math.max(0, Math.min(w - 1, c2[0])), Math.max(0, Math.min(h - 1, c2[1]))] : [0, 0]);
    }
    const quad = orderQuad(cs);
    if (quadOk(quad, w, h)) {
      const n = snapped.filter(Boolean).length;
      out.push({
        method: 'fused', quad,
        score: n ? sideScores.reduce((a, b) => a + b, 0) / n : 0,
        snapped, sideScores,
        note: `sides from ${n ? out.filter((c) => c.snapped.some((v, i) => snapped[i] && (c._lines as Line[])?.[i] === lines[i])).map((c) => c.method).join('+') : 'frame'}`,
      });
    }
  }
  return out;

  function finish(method: 'rules' | 'border',
      r: { lines: Line[]; snapped: boolean[]; note?: string }): QuadCandidate {
    // frame-clamped sides become the frame's own lines
    const frame: Line[] = [
      { a: 0, b: 1, c: 0 }, { a: 1, b: 0, c: gw - 1 },
      { a: 0, b: 1, c: gh - 1 }, { a: 1, b: 0, c: 0 },
    ];
    const lines = r.lines.map((l, i) => l ?? frame[i]);
    // full-resolution refinement for the fitted sides
    const inv = 1 / scale;
    const fullLines = lines.map((l, i) => {
      const fl: Line = { a: l.a, b: l.b, c: l.c * inv };
      if (!r.snapped[i]) return fl;
      // span: intersect with the two neighbours to bound the sampling range
      const p = intersect(fl, { a: lines[(i + 3) & 3].a, b: lines[(i + 3) & 3].b, c: lines[(i + 3) & 3].c * inv });
      const q = intersect(fl, { a: lines[(i + 1) & 3].a, b: lines[(i + 1) & 3].b, c: lines[(i + 1) & 3].c * inv });
      if (!p || !q) return fl;
      return refineSide(full, w, h, fl, [p[0], p[1], q[0], q[1]], Math.max(8, Math.round(4 * inv)), minStep);
    });
    const cs: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) {
      const c = intersect(fullLines[i], fullLines[(i + 3) & 3]);
      cs.push(c ? [Math.max(0, Math.min(w - 1, c[0])), Math.max(0, Math.min(h - 1, c[1]))] : [0, 0]);
    }
    const quad = orderQuad(cs);
    const ok = quadOk(quad, w, h);
    const sq = ok ? scoreQuad(full, w, h, quad, r.snapped, contrast) : { score: 0, sides: [0, 0, 0, 0] };
    return { method, quad, score: sq.score, snapped: r.snapped, sideScores: sq.sides,
      note: r.note, _lines: fullLines } as QuadCandidate;
  }
}

/** ---- the rule-guided approach ------------------------------------------ */
function rulesCandidate(g: Uint8Array, gw: number, gh: number, paper: number, minStep: number):
    { lines: Line[]; snapped: boolean[]; note: string } | null {
  const darkT = paper - 26;
  const stepX = Math.max(1, Math.floor(gw / 160));
  // slope sweep: variance of the sheared dark-fraction row profile peaks when
  // the shear matches the rules (index.ts ruleSlopeSwing, whole-page form)
  let bestS = 0, bestV = -1, bestProf: Float32Array | null = null;
  // Two hoists out of the 61 x gh x (gw/stepX) sweep, both EXACT: the darkness
  // test becomes one page pass instead of 61, and each sampled column's offset
  // from the shear centre is computed once. `Math.round(y + …)` is deliberately
  // NOT rewritten as `y + Math.round(…)`: y is an integer so the two agree in
  // real arithmetic, but the float64 sum rounds first and a sample sitting on a
  // .5 boundary can flip — measured, it moved page B's whole segmentation.
  const dark = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) dark[i] = g[i] < darkT ? 1 : 0;
  const xsQ: number[] = [];
  for (let x = 0; x < gw; x += stepX) xsQ.push(x);
  const kxQ = new Float64Array(xsQ.length);
  for (let k = 0; k < xsQ.length; k++) kxQ[k] = xsQ[k] - gw / 2;
  for (let s = -0.3; s <= 0.3001; s += 0.01) {
    const prof = new Float32Array(gh);
    let m = 0, m2 = 0, n = 0;
    for (let y = 0; y < gh; y++) {
      let d = 0, c = 0;
      for (let k = 0; k < xsQ.length; k++) {
        const yy = Math.round(y + s * kxQ[k]);
        if (yy < 0 || yy >= gh) continue;
        c++;
        d += dark[yy * gw + xsQ[k]];
      }
      if (!c) continue;
      prof[y] = d / c;
      m += prof[y]; m2 += prof[y] * prof[y]; n++;
    }
    const v = n ? m2 / n - (m / n) ** 2 : 0;
    if (v > bestV) { bestV = v; bestS = s; bestProf = prof; }
  }
  if (!bestProf) return null;
  // rule rows: profile peaks over an adaptive bar
  const sorted = Array.from(bestProf).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const bar = Math.max(0.14, med * 3);
  const rows: number[] = [];
  for (let y = 1; y < gh - 1; y++) {
    if (bestProf[y] >= bar && bestProf[y] >= bestProf[y - 1] && bestProf[y] >= bestProf[y + 1]) {
      if (!rows.length || y - rows[rows.length - 1] > 4) rows.push(y);
      else if (bestProf[y] > bestProf[rows[rows.length - 1]]) rows[rows.length - 1] = y;
    }
  }
  if (rows.length < 4) return null;
  const gaps = rows.slice(1).map((y, i) => y - rows[i]).sort((a, b) => a - b);
  const spacing = gaps[Math.floor(gaps.length / 2)];

  // EXTEND THE GRID THROUGH THE EMPTY RULES. The strict bar above only sees
  // rules with WRITING on them — a notebook's blank top/bottom rules are far
  // fainter, and stopping at the first written line made the top-edge scan
  // read the first line's own ink as "the page edge" (doubledia). A printed
  // rule this faint still shows in a SENSITIVE profile as a LINE: elevated
  // against its immediate neighbours. Dark background beyond a real page edge
  // is dark on the neighbours too, so the line test stops the extension there
  // — the grid measures how tall the RULED AREA is, never more.
  const darkT2 = paper - 12;
  const prof2 = new Float32Array(gh);
  for (let y = 0; y < gh; y++) {
    let d = 0, c = 0;
    for (let x = 0; x < gw; x += stepX) {
      const yy = Math.round(y + bestS * (x - gw / 2));
      if (yy < 0 || yy >= gh) continue;
      c++;
      if (g[yy * gw + x] < darkT2) d++;
    }
    prof2[y] = c ? d / c : 0;
  }
  const lineLike = (y: number): boolean => {
    const yi = Math.round(y);
    if (yi < 3 || yi >= gh - 3) return false;
    const nb = (prof2[yi - 3] + prof2[yi + 3]) / 2;
    return prof2[yi] >= 0.05 && prof2[yi] - nb >= 0.03;
  };
  const extend = (from: number, dir: -1 | 1): number => {
    let at = from;
    for (let it = 0; it < 200; it++) {
      const pred = at + dir * spacing;
      if (pred < 2 || pred > gh - 3) break;
      let best = -1, bestY = pred;
      for (let dy = -2; dy <= 2; dy++) {
        const yi = Math.round(pred + dy);
        if (yi < 3 || yi >= gh - 3) continue;
        if (lineLike(yi) && prof2[yi] > best) { best = prof2[yi]; bestY = yi; }
      }
      if (best < 0) break;
      at = bestY;
    }
    return at;
  };
  const topEx = extend(rows[0], -1);
  const botEx = extend(rows[rows.length - 1], 1);
  // The page's x-RANGE from between-rules PAPERNESS, not from the rules' dark
  // runs: a rule that reaches a dark background MERGES with it (its dark run
  // continues past the page edge to the frame), so rule extents cannot bound
  // the page there. The paper BETWEEN consecutive rules can: page columns are
  // bright at the rule midpoints, background columns are dark at every y.
  const midYs = rows.slice(1).map((y, i) => (y + rows[i]) / 2);
  const paperT2 = paper - 30;
  const frac = new Float32Array(gw);
  for (let x = 0; x < gw; x++) {
    let b = 0, c = 0;
    for (const my of midYs) {
      const yy = Math.round(my + bestS * (x - gw / 2));
      if (yy < 0 || yy >= gh) continue;
      c++;
      if (g[yy * gw + x] >= paperT2) b++;
    }
    frac[x] = c ? b / c : 0;
  }
  // longest run of paper-bright columns = the page's x-range
  let left = -1, right = -1, runL = -1, best = 0;
  for (let x = 0; x <= gw; x++) {
    const on = x < gw && frac[x] >= 0.55;
    if (on && runL < 0) runL = x;
    if (!on && runL >= 0) {
      if (x - runL > best) { best = x - runL; left = runL; right = x - 1; }
      runL = -1;
    }
  }
  if (left < 0 || right - left < gw * 0.4) return null;
  const topRule = topEx, botRule = botEx;

  const sample = (x: number, y: number) =>
    (x < 0 || y < 0 || x >= gw || y >= gh) ? 0 : g[Math.round(y) * gw + Math.round(x)];

  // per side: outward scans from the rule box, then a robust fit
  const lines: Array<Line | null> = [null, null, null, null];
  const snapped = [false, false, false, false];
  const K = 12;

  // top / bottom: scan vertically at K x positions, following the shear
  for (const [side, yFrom, yTo] of [
    [0, topRule - 0.6 * spacing, Math.max(0, topRule - 8 * spacing)] as const,
    [2, botRule + 0.6 * spacing, Math.min(gh - 1, botRule + 8 * spacing)] as const,
  ]) {
    // ruled area reaches the frame on this side: the sheet runs past it
    if (side === 0 && topRule - 0.6 * spacing <= 2) continue;
    if (side === 2 && botRule + 0.6 * spacing >= gh - 3) continue;
    const pts: Array<[number, number]> = [];
    for (let k = 0; k <= K; k++) {
      const x = left + ((right - left) * k) / K;
      const shear = bestS * (x - gw / 2);
      const t = outermostStep((y) => sample(x, y + shear), yFrom, yTo, minStep);
      if (t != null) pts.push([x, t + shear]);
    }
    // A side most scans could NOT find is not an edge — a handful of scattered
    // steps (a punch hole, a shadow blob) otherwise fits a confident wrong
    // line. It clamps to the frame instead, which is also the right answer for
    // a close-up whose page runs past the picture on that side.
    const l = pts.length >= Math.max(5, (K + 1) * 0.5) ? robustLine(pts) : null;
    if (l) { lines[side] = l; snapped[side] = true; }
  }
  // left / right: scan horizontally BETWEEN the rules — a scan along a rule's
  // own row has rule ink in its inside window, so the paper->background step
  // never clears the bar (page-c fitted zero sides until this moved)
  for (const [side, xFrom, xTo, atFrame] of [
    [3, left + 8, Math.max(0, left - gw * 0.15), left <= 2] as const,
    [1, right - 8, Math.min(gw - 1, right + gw * 0.15), right >= gw - 3] as const,
  ]) {
    if (atFrame) continue;   // the paper run reaches the frame on this side
    const pts: Array<[number, number]> = [];
    for (const yc0 of rows) {
      const yc = yc0 - spacing / 2;
      if (yc < 1) continue;
      const t = outermostStep((x) => sample(x, yc + bestS * (x - gw / 2)), xFrom, xTo, minStep);
      if (t != null) pts.push([t, yc + bestS * (t - gw / 2)]);
    }
    const l = pts.length >= Math.max(5, rows.length * 0.5) ? robustLine(pts) : null;
    if (l) { lines[side] = l; snapped[side] = true; }
  }
  return { lines: lines as Line[], snapped,
    note: `${rows.length} rules, slope ${bestS.toFixed(2)}, spacing ${spacing}px` };
}

/** ---- the border-scan approach ------------------------------------------ */
function borderCandidate(g: Uint8Array, gw: number, gh: number, paper: number, minStep: number):
    { lines: Line[]; snapped: boolean[]; note: string } | null {
  const paperT = paper - 28;
  const M = 24, RUN = Math.max(6, Math.round(Math.min(gw, gh) * 0.03));
  // First sustained paper run walking inward; null = paper starts at the
  // frame. The boundary must then VALIDATE as a page edge — the same two
  // impostors as outermostStep's: the region outside it must be sustained
  // dark (not flickering vignette), and the transition must be a sharp STEP
  // (a shadow's inner boundary is a ramp; fitting those is how the border
  // method drew diagonals through doubledia's and photorain's bottom bands).
  const firstPaper = (sample: (t: number) => number, from: number, to: number): number | null => {
    const dir = to > from ? 1 : -1, n = Math.abs(to - from);
    let run = 0;
    for (let k = 0; k < n; k++) {
      const t = from + k * dir;
      if (sample(t) >= paperT) { run++; if (run >= RUN) {
        const edge = t - dir * (RUN - 1);
        if (Math.abs(edge - from) < 3) return edge;   // paper starts at the frame
        let out = 0, oc = 0;
        for (let j = 4; j <= 14; j++) {
          const tt = edge - j * dir;
          if ((dir > 0 && tt < from) || (dir < 0 && tt > from)) break;
          out += sample(tt); oc++;
        }
        const sustainedDark = oc >= 4 && out / oc < paperT - 10;
        const tight = ((sample(edge + dir) + sample(edge + 2 * dir)) / 2)
          - ((sample(edge - dir) + sample(edge - 2 * dir)) / 2);
        const sharp = tight >= (paper - paperT) * 0.6;
        return sustainedDark && sharp ? edge : null;
      } }
      else run = 0;
    }
    return null;
  };
  const sx = (y: number) => (x: number) => g[Math.round(y) * gw + Math.max(0, Math.min(gw - 1, Math.round(x)))];
  const sy = (x: number) => (y: number) => g[Math.max(0, Math.min(gh - 1, Math.round(y))) * gw + Math.round(x)];

  const lines: Array<Line | null> = [null, null, null, null];
  const snapped = [false, false, false, false];
  const sides: Array<{ side: number; pts: Array<[number, number]>; atFrame: number }> = [];
  for (const side of [0, 1, 2, 3]) {
    const pts: Array<[number, number]> = [];
    let atFrame = 0;
    for (let k = 1; k < M; k++) {
      if (side === 0 || side === 2) {
        const x = (gw * k) / M;
        const t = firstPaper(sy(x), side === 0 ? 0 : gh - 1, side === 0 ? gh * 0.45 : gh * 0.55);
        if (t == null) continue;
        if (Math.abs(t - (side === 0 ? 0 : gh - 1)) <= 1) { atFrame++; continue; }
        pts.push([x, t]);
      } else {
        const y = (gh * k) / M;
        const t = firstPaper(sx(y), side === 3 ? 0 : gw - 1, side === 3 ? gw * 0.45 : gw * 0.55);
        if (t == null) continue;
        if (Math.abs(t - (side === 3 ? 0 : gw - 1)) <= 1) { atFrame++; continue; }
        pts.push([t, y]);
      }
    }
    sides.push({ side, pts, atFrame });
  }
  let fitted = 0;
  for (const { side, pts, atFrame } of sides) {
    // most scanlines already start on paper -> the sheet runs past this side
    if (atFrame > M * 0.55) continue;
    const l = pts.length >= (M - 1) * 0.5 ? robustLine(pts) : null;
    if (l) { lines[side] = l; snapped[side] = true; fitted++; }
  }
  if (!fitted) return null;
  return { lines: lines as Line[], snapped, note: `${fitted} sides fitted` };
}
