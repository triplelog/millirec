// Handwriting as outlines rather than pixels.
//
// A cleaned word is near-binary — solid ink, paper, and a thin antialiased rim —
// which is exactly the shape a contour tracer handles well. Storing the outline
// instead of the raster is smaller by an order of magnitude and, more usefully,
// resolution-independent: the same word stays crisp when a reader enlarges the
// text, and bolding becomes a stroke along the outline rather than a re-render.
//
// The pipeline for one word:
//   coverage -> threshold -> traceContours -> smoothLoop -> simplify -> beziers
//
// `traceContours` and `smoothLoop` are the margin recogniser's, already trusted
// on this kind of input. Only the simplify and curve-fitting steps are new.

import { traceContours, smoothLoop, type Pt } from './marginRecognition';

/** A traced word: closed loops in the crop's own pixel coordinates. */
export interface WordOutline {
  /** Closed loops. Outer boundaries and holes both appear here; the even-odd
   *  fill rule sorts them out, so counters in a/e/o stay open. */
  loops: Pt[][];
  width: number;
  height: number;
}

export interface TraceOptions {
  /** Coverage at or above this counts as ink. */
  threshold?: number;
  /** Chaikin-style smoothing passes before simplification. */
  smooth?: number;
  /** Simplification tolerance in px. Larger is smoother and smaller. */
  tolerance?: number;
  /** Drop loops with fewer points than this. 3 is the minimum that can enclose
   *  anything; this is a well-formedness check, NOT a size filter — see
   *  `minArea`. */
  minPoints?: number;
  /** Drop loops enclosing less than this many square px — antialiasing slivers,
   *  not marks. */
  minArea?: number;
  /** When smoothing COLLAPSES a loop that enclosed real area — Chaikin pulls a
   *  tiny contour toward its centroid, so a 2-3px i-dot can shrink under the
   *  filters above — replace it with a circle of the raw contour's area at the
   *  raw centroid instead of dropping it. Under the evenodd fill this is right
   *  for both polarities: a lost DOT renders as a dot, a collapsed COUNTER
   *  renders as a hole. Off by default: stored word outlines predate it, and
   *  the whole-page display render is the consumer that cannot afford a
   *  vanished mark (the vectoriser is a recorded way a dot disappears). */
  keepDots?: boolean;
}

const DEFAULTS: Required<TraceOptions> = {
  threshold: 128,
  smooth: 3,
  tolerance: 0.96,
  // Was 6, which silently deleted i and j dots. A point count measures a
  // contour's COMPLEXITY, not its size: simplification reduces anything round to
  // a handful of points however large it is, so a dot and a full stop and a
  // one-pixel speck all land at 4-5 points. Measured on the test photo, the dot
  // over the "i" of "likely" traced to a 5-point loop enclosing 17.8 px² — a
  // perfectly real mark, thrown away for being simple. Size is the thing being
  // filtered, so filter on size.
  minPoints: 3,
  // Small enough to keep any mark a pen can make at this scale (the crops are
  // height-normalized, so px are comparable across words), large enough to drop
  // the sub-pixel slivers a threshold leaves along a soft edge.
  minArea: 2,
  keepDots: false,
};

/** Twice the signed area of a closed polygon, via the shoelace formula. */
function loopArea2(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a);
}

/**
 * Ramer-Douglas-Peucker, iterative so a long contour cannot blow the stack.
 * Keeps the points that carry the shape and discards the ones on the line
 * between them.
 */
export function simplify(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts;
  const dist2 = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    if (!len) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
  };
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, z] = stack.pop()!;
    let worst = 0;
    let idx = -1;
    for (let i = a + 1; i < z; i++) {
      const d = dist2(pts[i], pts[a], pts[z]);
      if (d > worst) { worst = d; idx = i; }
    }
    if (idx >= 0 && worst > tolerance * tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, z]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Trace a single-channel coverage buffer (255 = ink) into closed outlines. */
export function traceInk(
  coverage: Uint8Array, width: number, height: number, opts: TraceOptions = {},
): WordOutline {
  const o = { ...DEFAULTS, ...opts };
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) mask[i] = coverage[i] >= o.threshold ? 1 : 0;
  const loops: Pt[][] = [];
  for (const raw of traceContours(mask, width, height)) {
    const s = simplify(smoothLoop(raw, o.smooth), o.tolerance);
    if (s.length >= o.minPoints && loopArea2(s) >= o.minArea * 2) { loops.push(s); continue; }
    if (!o.keepDots) continue;
    const rawA2 = loopArea2(raw);
    if (rawA2 < o.minArea * 2) continue; // a true sliver, dropped either way
    // The mark was real and the smoothing ate it: same-area circle, same spot.
    let cx = 0, cy = 0;
    for (const p of raw) { cx += p.x; cy += p.y; }
    cx /= raw.length; cy /= raw.length;
    const r = Math.max(0.6, Math.sqrt(rawA2 / 2 / Math.PI));
    const dot: Pt[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 2 * Math.PI;
      dot.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    loops.push(dot);
  }
  return { loops, width, height };
}

// ---- compact storage ------------------------------------------------------
//
// Contour points land on a half-integer grid, and tracing moves in small steps,
// so consecutive deltas are tiny. Doubling to integers and delta-encoding gets
// a word down to a few hundred bytes of plain text, which then gzips well —
// unlike base64 PNG, which is already compressed and gzips to nothing.
//
// This is LOSSY, deliberately: smoothing lands points off the half-integer grid,
// and snapping back to it costs at most 0.25px in the crop's own coordinates.
// Measured over 5,549 points of real ink the worst case was 0.2422px, and a crop
// renders at roughly a fifth of its stored size, so the error reaching a screen
// is about 0.05px. Round-tripping is therefore point-count exact and
// position-approximate; assert the bound, not equality.

/** Encode outlines to a compact string. Loops are separated by `|`. */
export function encodeOutline(outline: WordOutline): string {
  return outline.loops
    .map((loop) => {
      let px = 0;
      let py = 0;
      const parts: string[] = [];
      for (const p of loop) {
        const x = Math.round(p.x * 2);
        const y = Math.round(p.y * 2);
        parts.push(`${x - px},${y - py}`);
        px = x;
        py = y;
      }
      return parts.join(' ');
    })
    .join('|');
}

export function decodeOutline(encoded: string, width: number, height: number): WordOutline {
  const loops: Pt[][] = [];
  for (const chunk of encoded.split('|')) {
    if (!chunk) continue;
    const loop: Pt[] = [];
    let x = 0;
    let y = 0;
    for (const pair of chunk.split(' ')) {
      const c = pair.indexOf(',');
      if (c < 0) continue;
      x += Number(pair.slice(0, c));
      y += Number(pair.slice(c + 1));
      loop.push({ x: x / 2, y: y / 2 });
    }
    if (loop.length) loops.push(loop);
  }
  return { loops, width, height };
}

// ---- rendering ------------------------------------------------------------

/**
 * Closed loops to SVG path data, as cubic beziers.
 *
 * Control points come from Catmull-Rom, which passes through every point and
 * rounds the corners between them — the pen's own curvature, restored after
 * simplification threw away the intermediate samples.
 */
export function outlineToPath(outline: WordOutline, precision = 1): string {
  const r = (v: number) => Number(v.toFixed(precision));
  let d = '';
  for (const p of outline.loops) {
    const n = p.length;
    if (n < 3) continue;
    d += `M${r(p[0].x)} ${r(p[0].y)}`;
    for (let i = 0; i < n; i++) {
      const p0 = p[(i - 1 + n) % n];
      const p1 = p[i];
      const p2 = p[(i + 1) % n];
      const p3 = p[(i + 2) % n];
      d += `C${r(p1.x + (p2.x - p0.x) / 6)} ${r(p1.y + (p2.y - p0.y) / 6)}`
        + ` ${r(p2.x - (p3.x - p1.x) / 6)} ${r(p2.y - (p3.y - p1.y) / 6)}`
        + ` ${r(p2.x)} ${r(p2.y)}`;
    }
    d += 'Z';
  }
  return d;
}

export interface SvgOptions {
  /** Extra weight, in crop pixels. Stroking the filled outline with a round
   *  join dilates it by a disc — the same operation the raster path performed
   *  with a signed distance field, but resolution-independent and free. */
  weight?: number;
  /** Halo width in crop pixels — a softer band of the ink colour just outside
   *  the glyph. 0 disables it. Scales with the word, since the viewBox is the
   *  crop. */
  halo?: number;
  /** Halo opacity, as a fraction of full ink. */
  haloOpacity?: number;
  precision?: number;
}

/** Default halo: 1 crop px at two thirds ink.
 *
 *  Two thirds is not arbitrary. The blog's ink feed (generate-ink-feed.mjs,
 *  LEVELS = 3) quantises each paragraph to a palette built by ramping from
 *  paper to the ink colour in `levels` steps (`buildPalette`,
 *  a blog's PNG script), so with the default 3
 *  levels the entries are 1/3, 2/3 and full ink. The halo therefore lands
 *  EXACTLY on the second-darkest palette entry and survives quantisation without
 *  dithering or a wider palette.
 *
 *  It is expressed as opacity rather than a colour because that ramp is itself
 *  alpha compositing: `paper + (ink - paper) * a` is `mix(paper, ink, a)`. Two
 *  thirds of the ink colour over any background reproduces the palette entry on
 *  white paper and still behaves correctly on a dark one, which a hard-coded
 *  grey would not. */
export const HALO_PX = 1;
export const HALO_OPACITY = 2 / 3;

/** An SVG document painting the outline, sized to the crop.
 *
 *  This is consumed as a CSS MASK filled with `currentColor`, so what matters is
 *  the alpha channel, not the colours written here. That is what lets the halo
 *  be a second tone without a second layer or a second stored image: it is
 *  painted first at partial alpha and the solid glyph goes over the top, so the
 *  mask carries two levels and one masked element renders both. Keeping it to
 *  one layer is what preserves `currentColor` — and with it the per-word colour
 *  mark — which a two-colour background image would have thrown away. */
export function outlineToSvg(outline: WordOutline, opts: SvgOptions = {}): string {
  const d = outlineToPath(outline, opts.precision ?? 1);
  const w = opts.weight ?? 0;
  const halo = opts.halo ?? HALO_PX;
  const haloA = opts.haloOpacity ?? HALO_OPACITY;
  // fill-rule evenodd is what keeps the counters in a, e, o and p open: the
  // tracer winds every loop the same way, so the default non-zero rule would
  // fill the holes solid.
  const round = ' stroke-linejoin="round" stroke-linecap="round"';
  // A stroke is centred on the path, so half of each falls inside the glyph
  // where the solid pass covers it. Widths are doubled so both read as the
  // distance they extend OUTWARD. The halo starts from the weighted edge, not
  // the bare outline, or bolding would eat it.
  const haloPath = halo > 0
    ? `<path fill="none" stroke="#000" stroke-opacity="${haloA.toFixed(3)}"`
      + ` stroke-width="${((w + halo) * 2).toFixed(2)}"${round} d="${d}"/>`
    : '';
  const stroke = w > 0 ? ` stroke="#000" stroke-width="${(w * 2).toFixed(2)}"${round}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outline.width} ${outline.height}">`
    + haloPath
    + `<path fill="#000" fill-rule="evenodd" d="${d}"${stroke}/></svg>`;
}

/**
 * An SVG data URI for use as a CSS mask (`--hw-src`).
 *
 * Percent-encoded rather than base64: the payload stays text, so it compresses
 * in the HTML response. Base64 would defeat that, which is most of the point.
 */
export function outlineToDataUri(outline: WordOutline, opts: SvgOptions = {}): string {
  const svg = outlineToSvg(outline, opts);
  // Encode only what actually breaks a url("...") in a style attribute. Leaving
  // spaces and the rest as-is keeps the string short and gzip-friendly.
  const escaped = svg
    .replace(/%/g, '%25')
    .replace(/"/g, '%22')
    .replace(/#/g, '%23')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\n/g, '');
  return `data:image/svg+xml,${escaped}`;
}

/** Trace, then render straight to a mask data URI. */
export function vectorizeCoverage(
  coverage: Uint8Array, width: number, height: number,
  trace: TraceOptions = {}, svg: SvgOptions = {},
): { outline: WordOutline; encoded: string; dataUri: string } {
  const outline = traceInk(coverage, width, height, trace);
  return {
    outline,
    encoded: encodeOutline(outline),
    dataUri: outlineToDataUri(outline, svg),
  };
}

// ---- whole-page display re-render -----------------------------------------
//
// `segPage` is deliberately binary — every character re-rendered at one
// normalized darkness — which is right for the decoder and wrong for a reader:
// at 1125px working width a stroke is 2-4px wide, so the raster is a staircase
// with 1px nibbles wherever the photo's threshold wavered. Tracing it through
// the SAME pipeline the editor's word outlines use (contours → Chaikin →
// simplify → Catmull-Rom beziers) and filling with antialiasing reads as pen
// ink instead of fax output.
//
// DISPLAY ONLY, by construction: nothing here writes back into `segPage`, and
// no recognition path consumes the result — the corpus cannot move. Callers
// paint it AFTER refineInk/restoreDots have finished stamping, so the smooth
// page is the corrected page.

/** The 2D-context subset the path builder needs — DOM canvas, node-canvas and
 *  Path2D all satisfy it structurally. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Append an outline to a context path as the same Catmull-Rom cubics
 *  `outlineToPath` emits — one implementation of the curve, two sinks.
 *  The caller owns beginPath/fill/stroke and the fill rule (evenodd, or the
 *  counters in a/e/o fill solid). */
export function pathOutline(ctx: PathSink, outline: WordOutline): void {
  for (const p of outline.loops) {
    const n = p.length;
    if (n < 3) continue;
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 0; i < n; i++) {
      const p0 = p[(i - 1 + n) % n];
      const p1 = p[i];
      const p2 = p[(i + 1) % n];
      const p3 = p[(i + 2) % n];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y,
      );
    }
    ctx.closePath();
  }
}

/** Trace a grayscale page (paper light, ink dark) rather than a coverage map.
 *  `inkCut` is generous because segPage ink is a single normalized darkness on
 *  pure 255 paper — anything at or under it is ink, full stop. */
export function traceGray(
  gray: Uint8Array, width: number, height: number,
  inkCut = 200, trace: TraceOptions = {},
): WordOutline {
  const cov = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) cov[i] = gray[i] <= inkCut ? 255 : 0;
  return traceInk(cov, width, height, trace);
}

export interface SmoothInkOptions {
  trace?: TraceOptions;
  /** Grays at or under this count as ink. */
  inkCut?: number;
  /** Outward weight compensation in px. Chaikin smoothing cuts corners, and on
   *  a 2px stroke the corners ARE the edges, so the trace alone reads slightly
   *  starved — hairlines pinch. A round-joined stroke of this width puts the
   *  lost weight back; 0.3 was chosen by eye on doubledia against the raster
   *  (0 pinches, 0.6 starts to bold). */
  weight?: number;
  /** Ink color. Default: the page's own normalized darkness (the modal gray at
   *  or under `inkCut`), so the smooth render matches the raster's tone. */
  color?: string;
}

/** The context subset the smooth renderer needs. */
export interface FillSink extends PathSink {
  beginPath(): void;
  fill(rule?: 'nonzero' | 'evenodd'): void;
  stroke(): void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
}

/** Paint a smooth re-render of a cleaned grayscale page into `ctx`, in page
 *  coordinates (set a transform first to scale). Background is the caller's —
 *  only ink is painted. Returns the outline so a caller can reuse it (SVG
 *  export, hit-testing) without a second trace. */
export function renderSmoothInk(
  ctx: FillSink, gray: Uint8Array, width: number, height: number,
  opts: SmoothInkOptions = {},
): WordOutline {
  const inkCut = opts.inkCut ?? 200;
  let color = opts.color;
  if (!color) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < width * height; i++) if (gray[i] <= inkCut) hist[gray[i]]++;
    let ink = 0;
    for (let v = 1; v < 256; v++) if (hist[v] > hist[ink]) ink = v;
    color = `rgb(${ink},${ink},${ink})`;
  }
  // A binary page mask has no antialiasing slivers to filter, and a display
  // must not delete marks the raster showed: 0.5 keeps even a single pixel
  // (its half-integer contour is a 0.5px2 diamond), and keepDots means no
  // loop collapses silently.
  const outline = traceGray(gray, width, height, inkCut,
    { minArea: 0.5, keepDots: true, ...opts.trace });
  const w = opts.weight ?? 0.3;
  ctx.beginPath();
  pathOutline(ctx, outline);
  ctx.fillStyle = color;
  ctx.fill('evenodd');
  if (w > 0) {
    // Half of a centred stroke falls inside the fill; doubling makes `weight`
    // the distance the edge moves OUTWARD — same convention as outlineToSvg.
    ctx.strokeStyle = color;
    ctx.lineWidth = w * 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  return outline;
}
