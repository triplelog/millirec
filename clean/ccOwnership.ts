// WHICH LINE DOES EACH CONNECTED COMPONENT OF THE CLEANED PAGE BELONG TO.
//
// This is the ownership logic `server/public/wordgpu/page.mjs` grew inside
// `linesFromRecs` across three measured rounds (see the project notes, "TWO HARD PHOTO
// PAGES", the hanging-mark reassignment, and the À-bientôt diacritic case) —
// EXTRACTED HERE, UNCHANGED, so the decode bands and the editor's per-word
// crops read one implementation. page.mjs imports this through the cleanlab
// bundle; `cleanPage` uses it to mask Pass B's crops. Every constant below is
// a measurement recorded there — do not retune one consumer without the other,
// because they are the same code.
//
// The components are SEGPAGE's: the per-character clean render re-draws each
// accepted character from its own pixels, so marks that the segmenter's
// BRIDGED flood welds together (an accent within 3 px of the line above's
// period) come apart here — which is exactly why comp-level rules in
// ccWordSeg could not answer this question and these can.
//
// Verdicts: `ccOwner[c]` is a rec.line id, or -1 for UNCLAIMED/SHARED — and
// -1 means "keep it wherever it appears": the component stays present in both
// lines' bands and both lines' crops rather than being amputated from either.
//
// A TWO-LINE WELD IS NO LONGER ONE OF THOSE. When a component's ink has a real
// letter body in two lines it is CUT at its waist (the thinnest row between
// the two baselines) and each half becomes its own component with its own
// owner — so "shared" is now only for ink nothing has an opinion about, never
// for two letters the ink happened to join. Sharing a weld meant the ink was
// erased from NO band and painted into BOTH, which cost the lower line its
// word anyway; see the cut for the measurement.

import type { WordRec } from './passB/pipeline';
import { splitStrokes, resolveUnitLines } from './strokeSplit';

export interface ComponentOwnership {
  /** Per-pixel component id, -1 where segPage has no ink (>= 128). */
  ccLabel: Int32Array;
  /** Per-component owner: a rec.line id, or -1 = unclaimed/shared. */
  ccOwner: Int32Array;
  ccMinX: number[];
  ccMaxX: number[];
  ccMinY: number[];
  ccMaxY: number[];
  /** Median inter-line baseline gap (the working "line height"). */
  gap: number;
  /** How many components the orphan pass claimed — ink no word box covered,
   *  which would otherwise have been painted into every band it overlaps. */
  claimed: number;
  /** How many two-line welds were CUT at the gutter (each adds a component). */
  cut: number;
  /** For a pixel: the owner of nearby labelled ink within r=2 — `line` when any
   *  own/unclaimed ink is near (never whiten what might be ours), the foreign
   *  owner when only foreign ink is near, -1 when no ink is near. */
  nearOwnerAt: (p: number, line: number) => number;
  /** Components whose CORE ink sat in two lines' zones — the welds and deep
   *  descenders geometry had to arbitrate. Each carries the two candidate
   *  lines and the verdict taken, so a recognizer can second-guess it (see
   *  page.mjs arbitrateWelds) through `overrides`. */
  twoLine: { c: number; lines: number[]; owner: number; x0: number; y0: number; x1: number; y1: number }[];
}

/** A component ownership override, keyed by a pixel inside the component
 *  (component ids are deterministic for one segPage, so a pixel names the
 *  same component to every caller). */
export interface OwnershipOverride { x: number; y: number; line: number }

/**
 * Label segPage's components and vote each one to a line.
 *
 * `recs` are the live word records (status !== 'empty'), whose boxes and
 * `line`/`baselineY` drive the votes; owner ids are `rec.line` values.
 */
/** How far below a mark its own letter may sit, in x-heights (see the
 *  dot-belongs-to-its-stem pass). */
const MARK_STEM_REACH = 1.2;
/** How far the ink BESIDE a mark may end from its line's BASELINE and still
 *  count as the letters that mark trails. A letter rests on the baseline; a
 *  descender of the same line hangs a whole x-height past it and is not what
 *  the mark is trailing. */
const MARK_TRAIL_LEVEL = 0.35;

/**
 * THE SEGMENTER'S OWN LINE ASSIGNMENT, as a prior: `ccWordSeg`'s per-pixel
 * mask (segmenter line index + 1, 0 = it declined) and the bridge from those
 * indices to `rec.line` (`lineIds`). See the small-components pass below for
 * why this is the last word on a mark.
 */
export interface OwnershipPrior {
  mask: Int16Array;
  lineIds: number[];
}

export function componentOwnership(
  recs: WordRec[],
  segPage: Uint8Array,
  pageW: number,
  pageH: number,
  overrides: OwnershipOverride[] | null = null,
  prior: OwnershipPrior | null = null,
): ComponentOwnership | null {
  const byLine = new Map<number, WordRec[]>();
  for (const r of recs) {
    if (!byLine.has(r.line)) byLine.set(r.line, []);
    byLine.get(r.line)!.push(r);
  }
  if (byLine.size < 2) return null;

  const ccLabel = new Int32Array(pageW * pageH).fill(-1);
  let nCC = 0;
  // typed stack (a pixel is pushed once, so the page bounds it) and a
  // bounds-free path for interior pixels; the neighbour order is the general
  // path's, so component ids and extents are exactly what they were
  const stack = new Int32Array(pageW * pageH);
  const N8 = [-pageW - 1, -pageW, -pageW + 1, -1, 1, pageW - 1, pageW, pageW + 1];
  const ccMinY: number[] = [], ccMaxY: number[] = [], ccMinX: number[] = [], ccMaxX: number[] = [];
  for (let i = 0; i < pageW * pageH; i++) {
    if (segPage[i] >= 128 || ccLabel[i] >= 0) continue;
    const id = nCC++;
    ccLabel[i] = id;
    let minY = (i / pageW) | 0, maxY = minY, minX = i % pageW, maxX = minX;
    let sp = 0;
    stack[sp++] = i;
    while (sp > 0) {
      const p = stack[--sp];
      const py = (p / pageW) | 0, px = p - py * pageW;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (px > 0 && px < pageW - 1 && py > 0 && py < pageH - 1) {
        for (let k = 0; k < 8; k++) {
          const q = p + N8[k];
          if (segPage[q] < 128 && ccLabel[q] < 0) { ccLabel[q] = id; stack[sp++] = q; }
        }
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= pageH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= pageW) continue;
          const q = yy * pageW + xx;
          if (segPage[q] < 128 && ccLabel[q] < 0) { ccLabel[q] = id; stack[sp++] = q; }
        }
      }
    }
    ccMinY[id] = minY; ccMaxY[id] = maxY; ccMinX[id] = minX; ccMaxX[id] = maxX;
  }

  // Vote each component's line by which line's word boxes hold its ink;
  // DOMINANT (winner > 3x runner-up) owners are settled, ties go to the
  // contested pass. Conservative on purpose — see linesFromRecs' original
  // comments, which this preserves verbatim in behaviour.
  // Vote counts as one flat table, component x line (line INDEX in byLine's
  // order). This used to be a Map of Maps written once per box pixel — a
  // hash lookup and a boxed number per pixel of every word rectangle. The
  // orders the Maps carried are kept explicitly: `voteOrder` is the order
  // components first received a vote (the outer loop's), and a component's
  // voting lines are read in byLine order, which is the order they were
  // inserted — so every tie below breaks exactly as it did.
  const lineIds = [...byLine.keys()];
  const nL = lineIds.length;
  const lineIdx = new Map<number, number>(lineIds.map((l, i) => [l, i]));
  const cnt = new Int32Array(nCC * nL);
  const voted = new Uint8Array(nCC);
  const voteOrder: number[] = [];
  for (const [line, ws] of byLine) {
    const li = lineIdx.get(line)!;
    for (const w of ws) {
      // Votes read the PRISTINE box (`voteBox`), never the crop bounds: crop
      // rectangles are grown to cover owned descenders (extendCropsToOwnedInk),
      // and growing the voting rectangles instead was a measured negative
      // (photo 23 -> 36 errors) — an expanded box votes on the next line's
      // ascenders and the bands shift under the reader.
      const vb = w.voteBox ?? w;
      const yA = Math.max(0, vb.y0), yB = Math.min(pageH - 1, vb.y1);
      const xA = Math.max(0, vb.x0), xB = Math.min(pageW - 1, vb.x1);
      for (let y = yA; y <= yB; y++) {
        const row = y * pageW;
        for (let x = xA; x <= xB; x++) {
          const c = ccLabel[row + x];
          if (c < 0) continue;
          if (!voted[c]) { voted[c] = 1; voteOrder.push(c); }
          cnt[c * nL + li]++;
        }
      }
    }
  }
  // A line's baseline is the median of its records' — except that a record
  // spanning TWO lines (a weld the segmenter could not cut: warehouse2's
  // "full again." over "### Costs") carries whichever baseline its ink
  // bottomed out on, the LOWER one, a full pitch below its own line. With two
  // records on the line the upper median IS that record, so line 5 took line
  // 6's baseline: every contested component then measured identical cores in
  // both lines (151/151, 67/67 …), no cut had a gutter to land in, the weld
  // stayed whole and the page read `is Fg gagging ## Co`. Only in the browser
  // — its Pass B attached 444 to that record where node's attached 393 (the
  // two rasterize the page a few pixels apart, and this box sits on that
  // edge), which is why no node gate saw it. So: a record taller than the line
  // pitch does not vote for its line's baseline while an ordinary one can.
  // The pitch itself comes from a first, naive pass — a hijacked line
  // collapses onto its neighbour (diff 0, filtered) and the rest still
  // measure the pitch.
  const baseOf = (ws: WordRec[]): number => {
    const bs = ws.map((w) => w.baselineY).sort((a, b) => a - b);
    return bs[bs.length >> 1];
  };
  const lineBase = new Map<number, number>();
  for (const [l, ws] of byLine) lineBase.set(l, baseOf(ws));
  {
    const b0 = [...lineBase.values()].sort((a, b) => a - b);
    const d0 = b0.slice(1).map((b, i) => b - b0[i]).filter((d) => d > 4).sort((a, b) => a - b);
    const pitch0 = d0.length ? d0[d0.length >> 1] : 50;
    for (const [l, ws] of byLine) {
      const ordinary = ws.filter((w) => { const b = w.voteBox ?? w; return b.y1 - b.y0 + 1 <= pitch0 * 1.2; });
      if (ordinary.length && ordinary.length < ws.length) lineBase.set(l, baseOf(ordinary));
    }
  }
  const bases = [...lineBase.values()].sort((a, b) => a - b);
  const diffs = bases.slice(1).map((b, i) => b - bases[i]).filter((d) => d > 4).sort((a, b) => a - b);
  const gap = diffs.length ? diffs[diffs.length >> 1] : 50;
  const xh = gap * 0.45;

  let ccOwner = new Int32Array(nCC).fill(-1);
  let nClaimed = 0;
  let nCut = 0;
  const toCut: { c: number; upper: number; lower: number }[] = [];
  const contested = new Map<number, number[]>();
  for (const c of voteOrder) {
    let bestL = -1, best = 0, second = 0, nVoters = 0;
    const lines: number[] = [];
    for (let li = 0; li < nL; li++) {
      const n = cnt[c * nL + li];
      if (!n) continue;
      nVoters++;
      lines.push(lineIds[li]);
      if (n > best) { second = best; best = n; bestL = lineIds[li]; }
      else if (n > second) second = n;
    }
    // A component TALL enough to span two lines is never settled by vote
    // dominance alone: a residue-widened word box can cover most of a two-line
    // weld and make the wrong line "dominant" (warehouse2's Parking-g welded
    // onto "new" below — line 9's line-wide box owned the whole weld 3x over,
    // so the g rendered inside "new"'s crop). The contested pass can actually
    // look at where the letter bodies are, so tall multi-line components go
    // there whatever their vote ratio says.
    const tall = ccMaxY[c] - ccMinY[c] + 1 > gap * 0.9;
    if (bestL >= 0 && best > second * 3 && !(tall && nVoters >= 2)) ccOwner[c] = bestL;
    else if (nVoters >= 2) contested.set(c, lines);
  }

  // CONTESTED components: which line's CORE region (letter bodies) holds the
  // ink — decisively, >= 2x, or a genuinely welded two-line component stays
  // shared — and for core-less ink (commas, dots, quote ticks) which baseline
  // it could be a mark OF, measured from the ink's BOTTOM: within [-2.0, +0.6]
  // x-heights above the baseline, nearest passing baseline wins.
  if (contested.size) {
    const core = new Map<number, Map<number, number>>();
    const coreX = new Map<number, Map<number, [number, number, number, number]>>();
    const bottom = new Map<number, number>();
    for (let p = 0; p < pageW * pageH; p++) {
      const c = ccLabel[p];
      if (c < 0 || !contested.has(c)) continue;
      const y = (p / pageW) | 0;
      const x = p % pageW;
      if (!((bottom.get(c) as number) > y)) bottom.set(c, y);
      for (const l of contested.get(c)!) {
        const b = lineBase.get(l)!;
        if (y >= b - gap * 0.55 && y <= b + gap * 0.08) {
          let m = core.get(c);
          if (!m) core.set(c, m = new Map());
          m.set(l, (m.get(l) || 0) + 1);
          let mx = coreX.get(c);
          if (!mx) coreX.set(c, mx = new Map());
          const ext = mx.get(l);
          if (!ext) mx.set(l, [x, x, y, y]);
          else {
            if (x < ext[0]) ext[0] = x; if (x > ext[1]) ext[1] = x;
            if (y < ext[2]) ext[2] = y; if (y > ext[3]) ext[3] = y;
          }
        }
      }
    }
    for (const [c, lines] of contested) {
      const m = core.get(c) || new Map<number, number>();
      let bestL = -1, best = 0, second = 0;
      for (const l of lines) {
        const n = m.get(l) || 0;
        if (n > best) { second = best; best = n; bestL = l; }
        else if (n > second) second = n;
      }
      // A WELD OUTRANKS DECISIVENESS. Core counts can be lopsided when a small
      // letter welds onto a whole word (Parking's g onto "new": the g's bowl
      // is one letter's core against a word's), so "decisively line 9" was
      // still amputating the g from line 8. What a tail can never fake is
      // core EXTENT: a descender crossing the zone below is one stroke wide,
      // and a tall letter poking into the neighbouring zone covers only a
      // sliver of its height — a welded letter BODY spans real x-extent AND a
      // real vertical range of the zone, in BOTH lines. That is the cut's own
      // safety argument, applied as the trigger.
      const mx = coreX.get(c);
      const weldy = [...lines]
        .filter((l) => {
          if ((m.get(l) || 0) < 3) return false;
          const ext = mx?.get(l);
          if (!ext) return false;
          return ext[1] - ext[0] + 1 >= xh * 0.5 && ext[3] - ext[2] + 1 >= xh * 0.4;
        })
        .sort((a, b) => lineBase.get(a)! - lineBase.get(b)!);
      {
        const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
        if (t && ccMaxX[c] >= t[0] && ccMinX[c] <= t[2] && ccMaxY[c] >= t[1] && ccMinY[c] <= t[3]) {
          console.log(`[own] contested comp ${c} x${ccMinX[c]}-${ccMaxX[c]} y${ccMinY[c]}-${ccMaxY[c]} core=${JSON.stringify([...m.entries()])} coreX=${JSON.stringify([...(mx ?? new Map()).entries()])} weldy=${JSON.stringify(weldy)} best=${best}/${second}`);
          console.log(`[own] lines ` + lines.map((l) => `${l}: base=${lineBase.get(l)} recs=[${(byLine.get(l) ?? []).map((w) => `${w.x0}-${w.x1}@${w.baselineY}`).join(' ')}]`).join(' | ') + ` gap=${gap}`);
        }
      }
      // A component with ink in BOTH lines' zones — however the core counts
      // fall — is first taken apart along its STROKES (splitStrokes): a g's
      // loop that runs the full depth of the line below, welded to an `e`
      // there, has 163 core pixels in the lower zone and 19 in the upper, so
      // every count-based rule hands the whole thing, `e` included, to the
      // line below. The skeleton says what the pen did.
      {
        const two = [...m.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 2)
          .sort((a, b) => lineBase.get(a)! - lineBase.get(b)!);
        const tallC = ccMaxY[c] - ccMinY[c] + 1 > gap * 0.9;
        if (two.length === 2 && tallC && !toCut.some((t) => t.c === c)) { toCut.push({ c, upper: two[0], lower: two[1] }); continue; }
      }
      if (weldy.length === 2) { toCut.push({ c, upper: weldy[0], lower: weldy[1] }); continue; }
      if (best >= 3 && best >= second * 2) { ccOwner[c] = bestL; continue; }
      if (best >= 3) {
        // WELDED — AND NOW CUT, not shared. A width test does NOT separate this
        // from a descender, which was tried and measured: the `g` of
        // warehouse2's "full again." is one 23x69 component reaching the line
        // below, and its core ink there is ~18 px, narrower than a letter
        // body's 0.6-1.0 xh, so a `descenderW` bar of 0.8 xh claimed the whole
        // thing for the upper line. It is not a descender: the `g` and the `s`
        // of "Costs" TOUCH, so the component is BOTH letters, and giving it to
        // line 5 deleted the `s` from line 6 (`Co ts`, pooled 249 -> 250).
        //
        // Sharing was the right answer for a weld and the wrong one for the
        // symptom: an unresolved component is erased from NO band, so it gets
        // painted into both, and in the band below it sits over the `s` and
        // costs the word anyway (`Colts`). So neither whole-component verdict
        // is available — which is the argument for cutting, and it is what this
        // note asked for. `cutAtWaist` splits the ink at its narrowest row
        // BETWEEN the two core zones and gives each side its own line; the
        // halves become separate components, which every consumer already
        // understands because ownership is per-component.
        //
        // The cut can only land in the inter-line gutter (below the upper
        // core, above the lower core), so it cannot slice either letter body —
        // that is what makes a straight row safe here where a width test was
        // not. Where no such row exists the component stays shared, i.e. the
        // old conservative failure is still the fallback.
        const two = [...lines].filter((l) => (m.get(l) || 0) >= 3)
          .sort((a, b) => lineBase.get(a)! - lineBase.get(b)!);
        if (two.length === 2) toCut.push({ c, upper: two[0], lower: two[1] });
        continue;
      }
      const bot = bottom.get(c)!;
      let markL = -1, markD = Infinity;
      for (const l of lines) {
        const b = lineBase.get(l)!;
        if (bot < b - 2.0 * xh || bot > b + 0.6 * xh) continue;
        const d = Math.abs(bot - b);
        if (d < markD) { markD = d; markL = l; }
      }
      if (markL >= 0) ccOwner[c] = markL;
    }
  }

  // Every two-line component and the verdict geometry took, for the recognizer
  // to second-guess. Recorded BEFORE the cut stage, on the whole component.
  const twoLine: ComponentOwnership['twoLine'] = [];
  for (const [c, lines] of contested) {
    if (lines.length !== 2) continue;
    twoLine.push({ c, lines: [...lines], owner: ccOwner[c], x0: ccMinX[c], y0: ccMinY[c], x1: ccMaxX[c], y1: ccMaxY[c] });
  }

  // ---- CUT the welds ---------------------------------------------------------
  // Split each two-line weld at its narrowest row in the gutter between the two
  // core zones. The lower half becomes a NEW component with its own owner, so
  // the halves are ordinary per-component verdicts to every consumer
  // (`ownershipMask`, `nearOwnerAt`, the band whitening in `linesFromRecs`) and
  // no caller learns a new concept.
  if (toCut.length) {
    const owners: number[] = [];
    for (const { c, upper, lower } of toCut) {
      const b1 = lineBase.get(upper)!, b2 = lineBase.get(lower)!;
      // SEARCH BETWEEN THE BASELINES, not between the core zones. The core
      // gutter is the wrong window and it was measured being wrong: on
      // warehouse2's `g`+`s` the core bounds give rows 398-415, and the ink
      // profile there is a UNIFORM 4-5 px — the descender's tail, where every
      // row ties and "narrowest" means nothing. The real waist is at 419 with
      // ONE pixel, the bridge where the tail touches the `s`, and it sits
      // BELOW the core window because an x-height `s` starts lower than the
      // core zone's top. Cutting mid-tail left its bottom 13 rows owned by the
      // line below, which is the stray tick over the `s` that made `Colts`.
      // FIRST THE STROKES. Thin the component, read its skeleton as cycles and
      // chains, and give each unit a line: a unit whose top touches the upper
      // line's zone (or its ink) hangs from that line, one whose top starts
      // inside the lower x-height band is the lower line's, and the undecided
      // follow what they are attached to (clean/strokeSplit.ts). Where that
      // yields ink for both lines, the pixels are relabelled per line and the
      // waist cut below never runs.
      {
        const xh0 = 0.55 * gap;
        const Lt = b2 - xh0;                       // the lower line's x-height top
        const bx0 = Math.max(0, ccMinX[c] - 1), by0 = Math.max(0, ccMinY[c] - 1);
        const bw = Math.min(pageW - 1, ccMaxX[c] + 1) - bx0 + 1, bh = Math.min(pageH - 1, ccMaxY[c] + 1) - by0 + 1;
        const mask = new Uint8Array(bw * bh);
        let nMask = 0;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          if (ccLabel[(y + by0) * pageW + (x + bx0)] === c) { mask[y * bw + x] = 1; nMask++; }
        }
        const penW = Math.max(2, Math.round(0.12 * xh0));
        const sp = nMask > 8 ? splitStrokes(mask, bw, bh, penW) : null;
        if (sp) {
          // does a unit's ink touch (within 2 px) ink the upper line already owns?
          const touchesUpper = (u: { pixels: number[] }): boolean => {
            for (const l of u.pixels) {
              const ly = (l / bw) | 0, lx = l - ly * bw;
              const px = lx + bx0, py = ly + by0;
              for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                const xx = px + dx, yy = py + dy;
                if (xx < 0 || yy < 0 || xx >= pageW || yy >= pageH) continue;
                const o = ccLabel[yy * pageW + xx];
                if (o >= 0 && o !== c && ccOwner[o] === upper) return true;
              }
            }
            return false;
          };
          // A unit starting INSIDE the lower band is the lower line's — with a
          // few pixels of slack above the band's top, because the band top is
          // an estimate (0.55 of the pitch) and a letter body starts at the
          // x-height it was actually written at. Measured on warehouse2: the
          // `s` of "Costs" (a 108 px chain) starts at row 415 against a band
          // top of 416, so it was undecided, followed the `g` it touches, and
          // went UP with it in node and browser alike — line 6 lost its `s`
          // (node still decoded `Co ts` as Costs; the browser read `Co`).
          const belowSlack = Math.max(2, Math.round(0.06 * gap));
          const lines = resolveUnitLines(sp,
            (u) => {
              const top = u.y0 + by0;
              if (top <= b1 + 2 || touchesUpper(u)) return 0;
              if (top >= Lt - belowSlack) return 1;
              return -1;
            },
            (u) => ((u.y0 + by0) - b1 < Lt - (u.y0 + by0) ? 0 : 1));
          const nUp = sp.units.filter((u) => lines[u.id] === 0).length;
          const nDown = sp.units.length - nUp;
          {
            const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
            if (t && ccMaxX[c] >= t[0] && ccMinX[c] <= t[2] && ccMaxY[c] >= t[1] && ccMinY[c] <= t[3]) {
              console.log(`[own] STROKES comp ${c} x${ccMinX[c]}-${ccMaxX[c]} y${ccMinY[c]}-${ccMaxY[c]}: ` + sp.units.map((u) => `${u.kind}#${u.id}(${u.pixels.length}px top${u.y0 + by0})→${lines[u.id] === 0 ? 'up' : 'down'}`).join(' '));
            }
          }
          if (nUp && nDown) {
            // relabel the lower units into a new component; the upper keep `c`
            const id = ccMinX.length;
            const lo = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0 };
            const hi = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0 };
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
              const l = y * bw + x;
              if (!mask[l]) continue;
              const u = sp.unitOf[l];
              const down = u >= 0 && lines[u] === 1;
              const p = (y + by0) * pageW + (x + bx0);
              const t = down ? lo : hi;
              if (down) ccLabel[p] = id;
              const px = x + bx0, py = y + by0;
              if (px < t.minX) t.minX = px; if (px > t.maxX) t.maxX = px;
              if (py < t.minY) t.minY = py; if (py > t.maxY) t.maxY = py;
              t.n++;
            }
            if (lo.n && hi.n) {
              ccMinX[c] = hi.minX; ccMaxX[c] = hi.maxX; ccMinY[c] = hi.minY; ccMaxY[c] = hi.maxY;
              ccMinX.push(lo.minX); ccMaxX.push(lo.maxX); ccMinY.push(lo.minY); ccMaxY.push(lo.maxY);
              ccOwner[c] = upper;
              owners.push(lower);
              nCut++;
              continue;
            }
            if (lo.n) for (let p = 0; p < ccLabel.length; p++) if (ccLabel[p] === id) ccLabel[p] = c;
          } else if (nUp || nDown) {
            // every stroke on one side: that line owns it whole, no cut
            ccOwner[c] = nUp ? upper : lower;
            continue;
          }
        }
      }
      const y0 = Math.max(Math.floor(b1) + 1, ccMinY[c] + 1);
      const y1 = Math.min(Math.ceil(b2) - 1, ccMaxY[c] - 1);
      if (y1 < y0) continue;                       // nothing between the baselines: stays shared
      // The thinnest row IS the weld: two letter bodies joined by a bridge, and
      // the bridge is where the ink pinches. Ties go to the LOWEST such row —
      // a descender belongs to the letter it hangs from, so when the ink gives
      // no reason to prefer one row the cut keeps the stroke with the line
      // above and hands the line below only what is unambiguously its own.
      let cutY = -1, cutN = Infinity;
      for (let y = y0; y <= y1; y++) {
        let n = 0;
        for (let x = ccMinX[c]; x <= ccMaxX[c]; x++) if (ccLabel[y * pageW + x] === c) n++;
        if (n <= cutN) { cutN = n; cutY = y; }
      }
      if (cutY < 0) continue;
      {
        const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
        if (t && ccMaxX[c] >= t[0] && ccMinX[c] <= t[2]) console.log(`[own] CUT comp ${c} at row ${cutY} (n=${cutN}) window ${y0}-${y1} baselines ${b1.toFixed(0)}/${b2.toFixed(0)}`);
      }
      // relabel everything below the cut, and re-derive both halves' bounds
      const id = ccMinX.length;
      let lo = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0 };
      let hi = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0 };
      for (let y = ccMinY[c]; y <= ccMaxY[c]; y++) {
        for (let x = ccMinX[c]; x <= ccMaxX[c]; x++) {
          const p = y * pageW + x;
          if (ccLabel[p] !== c) continue;
          const t = y > cutY ? lo : hi;
          if (y > cutY) ccLabel[p] = id;
          if (x < t.minX) t.minX = x; if (x > t.maxX) t.maxX = x;
          if (y < t.minY) t.minY = y; if (y > t.maxY) t.maxY = y;
          t.n++;
        }
      }
      if (!lo.n || !hi.n) {                        // degenerate: put it back
        if (lo.n) for (let p = 0; p < ccLabel.length; p++) if (ccLabel[p] === id) ccLabel[p] = c;
        continue;
      }
      ccMinX[c] = hi.minX; ccMaxX[c] = hi.maxX; ccMinY[c] = hi.minY; ccMaxY[c] = hi.maxY;
      ccMinX.push(lo.minX); ccMaxX.push(lo.maxX); ccMinY.push(lo.minY); ccMaxY.push(lo.maxY);
      ccOwner[c] = upper;
      owners.push(lower);
      nCut++;
    }
    if (owners.length) {
      const grown = new Int32Array(ccOwner.length + owners.length);
      grown.set(ccOwner);
      owners.forEach((o, i) => { grown[ccOwner.length + i] = o; });
      ccOwner = grown;
    }
  }
  // A HANGING MARK GROUPED ONTO THE WRONG LINE arrives here DOMINANTLY owned,
  // so the contested pass never sees it: a trailing comma drawn wholly below
  // its baseline gets pushed to the next line by the segmenter's assignLine.
  // Re-judge mark-sized components sitting entirely OUTSIDE their owner's
  // letter zone by the bottom-plausibility window, widened to +0.85 xh (this
  // writer's trailing comma dips +0.7); the widening is safe ONLY because
  // up-moves are gated on a destination-line word ending within 0.6 xh left of
  // the mark — without the gate it steals opening quotes up to the previous line.
  for (let c = 0; c < ccOwner.length; c++) {
    const own = ccOwner[c];
    if (own < 0) continue;
    const h = ccMaxY[c] - ccMinY[c] + 1, w = ccMaxX[c] - ccMinX[c] + 1;
    if (h > gap * 0.5 || w > gap * 0.9) continue;
    const b = lineBase.get(own);
    if (b === undefined) continue;
    const inCore = !(ccMaxY[c] < b - gap * 0.55 || ccMinY[c] > b + gap * 0.08);
    if (inCore) continue;
    const bot = ccMaxY[c];
    let bestL = -1, bestD = Infinity;
    for (const [l, lb] of lineBase) {
      if (bot < lb - 2.0 * xh || bot > lb + 0.85 * xh) continue;
      const d = Math.abs(bot - lb);
      if (d < bestD) { bestD = d; bestL = l; }
    }
    if (bestL >= 0 && bestL !== own) {
      if ((lineBase.get(bestL) as number) < (lineBase.get(own) as number)) {
        const ws = byLine.get(bestL) || [];
        let tight = false;
        for (const r of ws) {
          const vb = r.voteBox ?? r;
          if (vb.x0 < ccMinX[c] && ccMinX[c] - vb.x1 < xh * 0.6) { tight = true; break; }
        }
        if (!tight) continue;
      }
      ccOwner[c] = bestL;
    }
  }
  // A DIACRITIC IS ABOVE ITS LETTER, which bottom-plausibility structurally
  // cannot see (the À-bientôt case: the accent's bottom is 14 px below the
  // PREVIOUS line's baseline and 38 px above its own). The claim an accent can
  // make instead: there is a LETTER directly beneath me, close, and it belongs
  // to another line. Requiring the body below to be owned by a DIFFERENT line
  // keeps ordinary i-dots — whose stem is on their own line — out entirely.
  // 0.35 xh, measured: at 0.6 this pass stole trailing commas downward.
  for (let c = 0; c < ccOwner.length; c++) {
    const own = ccOwner[c];
    if (own < 0) continue;
    const h = ccMaxY[c] - ccMinY[c] + 1, w = ccMaxX[c] - ccMinX[c] + 1;
    if (h > gap * 0.5 || w > gap * 0.9) continue;        // mark-sized only
    const b = lineBase.get(own);
    if (b === undefined) continue;
    // A mark IN or ABOVE its own line's letter zone is that line's business —
    // only ink hanging clearly BELOW the zone can be an accent grouped one
    // line too high (the À-bientôt case: the accent hangs below the wrong
    // owner's baseline). Judged at the mark's MIDPOINT: warehouse2's g-bowl
    // piece sat INSIDE line 8's zone, yet its seam-severed tail below read as
    // "a letter beneath me" and dragged the bowl onto line 9.
    if ((ccMinY[c] + ccMaxY[c]) / 2 <= b + gap * 0.08) continue;
    const cx = (ccMinX[c] + ccMaxX[c]) / 2;
    let bodyL = -1, bodyGap = Infinity;
    for (let d = 0; d < ccOwner.length; d++) {
      if (d === c || ccOwner[d] < 0 || ccOwner[d] === own) continue;
      if (ccMinY[d] <= ccMaxY[c]) continue;                       // must be BELOW the mark
      const vg = ccMinY[d] - ccMaxY[c];
      if (vg > xh * 0.35) continue;                               // …and close below it
      if (w > (ccMaxX[d] - ccMinX[d] + 1)) continue;               // no wider than its letter
      if (cx < ccMinX[d] || cx > ccMaxX[d]) continue;             // …and directly under it
      if (ccMaxY[d] - ccMinY[d] + 1 < xh * 0.5) continue;         // a letter body, not a speck
      if (vg < bodyGap) { bodyGap = vg; bodyL = ccOwner[d]; }
    }
    if (bodyL >= 0) ccOwner[c] = bodyL;
  }

  // ---- A SMALL COMPONENT BELONGS WHERE THE SEGMENTER PUT IT --------------
  //
  // Every pass above decides a mark's line from WHERE IT SITS: which word boxes
  // cover it, where its bottom falls against the baselines. On tight ruling the
  // boxes overlap and the baselines are a line-height apart, and a mark sits
  // between two lines by construction — so those tests keep answering the
  // wrong line for i-dots (nearer the line ABOVE's baseline than their own), for
  // a descender's severed tail (nearer the line BELOW's), and, once a rule was
  // written to catch each of those, for the letter or dot that happened to sit
  // in the same column as what the rule was looking for (measured: `copy`'s c
  // handed up to the line above because `pages`' g-tail ended just over it;
  // three i-dots handed up because a descender of the line above ended just
  // over them).
  //
  // The segmenter already answered the question the right way round. It reads
  // ATTACHMENT, not position: its components are BRIDGED (a tail a pixel off
  // its stroke is one component with it), its mark rules ask what a mark is
  // beside and beneath, and its verdict reaches every crop as `lineMask`. So
  // for a small component, the segmenter's line is taken over anything the
  // boxes said; the geometry above stays the fallback for the marks it left
  // unclaimed, and for a page read without it.
  //
  // Measured on the card that prompted it: four components where the two
  // disagreed, and the segmenter right on all four.
  const segLineOf = new Int32Array(nCC).fill(-2);   // -2 = not computed
  if (prior && prior.mask.length === pageW * pageH) {
    const nMask = prior.lineIds.length + 2;
    const counts = new Int32Array(nCC * nMask);
    for (let p = 0; p < pageW * pageH; p++) {
      const c = ccLabel[p];
      if (c < 0) continue;
      const v = prior.mask[p];
      // mask values are segmenter line index + 1; the bridge maps them to
      // rec.line, which is what every verdict here is expressed in
      const li = v > 0 ? prior.lineIds.indexOf(v - 1) : -1;
      counts[c * nMask + (li < 0 ? 0 : li + 1)]++;
    }
    for (let c = 0; c < nCC; c++) {
      let best = 0, bestN = 0;
      for (let k = 0; k < nMask; k++) {
        const n = counts[c * nMask + k];
        if (n > bestN) { bestN = n; best = k; }
      }
      segLineOf[c] = best === 0 ? -1 : best - 1;
    }
  }
  for (let c = 0; c < ccOwner.length; c++) {
    const own = ccOwner[c];
    if (own < 0) continue;
    const h = ccMaxY[c] - ccMinY[c] + 1, w = ccMaxX[c] - ccMinX[c] + 1;
    if (h > gap * 0.5 || w > gap * 0.9) continue;                  // small ones only
    const seg = segLineOf[c];
    if (seg >= 0 && byLine.has(seg)) {
      // the segmenter spoke: its attachment reading wins
      if (seg !== own) ccOwner[c] = seg;
      continue;
    }
    if (seg === -1 && prior) continue;   // it declined on purpose; leave the geometry's verdict
    // No prior at all (a caller without the segmenter's mask): the one
    // attachment test this file can make on its own — a dot belongs to the
    // stem beneath it, unless something of its own line rests beside it (a
    // comma trails its word; a dot has only paper at its height).
    const cx = (ccMinX[c] + ccMaxX[c]) / 2;
    const ownBase = lineBase.get(own);
    let beside = false;
    for (let d = 0; d < ccOwner.length && !beside; d++) {
      if (d === c || ccOwner[d] !== own || ownBase === undefined) continue;
      if (ccMaxY[d] < ccMinY[c] || ccMinY[d] > ccMaxY[c]) continue;
      if (Math.abs(ccMaxY[d] - ownBase) > xh * MARK_TRAIL_LEVEL) continue;
      const hg = ccMinX[d] > ccMaxX[c] ? ccMinX[d] - ccMaxX[c] : ccMinX[c] - ccMaxX[d];
      if (hg <= xh * 1.5) beside = true;
    }
    if (beside) continue;
    let stem = -1;
    let stemGap = Infinity;
    for (let d = 0; d < ccOwner.length; d++) {
      if (d === c || ccOwner[d] < 0) continue;
      if (ccMinY[d] <= ccMaxY[c]) continue;
      const vg = ccMinY[d] - ccMaxY[c];
      if (vg > xh * MARK_STEM_REACH || vg >= stemGap) continue;
      if (w > ccMaxX[d] - ccMinX[d] + 1) continue;
      if (cx < ccMinX[d] - xh * 0.25 || cx > ccMaxX[d] + xh * 0.25) continue;
      if (ccMaxY[d] - ccMinY[d] + 1 < xh * 0.45) continue;
      stemGap = vg;
      stem = d;
    }
    if (stem >= 0 && ccOwner[stem] !== own) ccOwner[c] = ccOwner[stem];
  }

  // ORPHANS: ink NO word rectangle covers, which every pass above skips.
  //
  // All four re-judging passes open with `if (ccOwner[c] < 0) continue` — they
  // move an owned component to a better line, and none of them can CLAIM one.
  // A component that collected no votes at all therefore keeps -1 forever, and
  // -1 does not mean "shared" to the consumer: `linesFromRecs` only whitens ink
  // whose owner is another line, so an unclaimed component is painted into
  // EVERY band that overlaps it. Measured on warehouse2: `separateCrossLine`
  // cuts the `g` of "full again." where its descender approaches the line
  // below, and the severed tail — covered by neither line's word boxes — is
  // drawn into both. In the band below it lands just above the `s` of "Costs"
  // and the decoder reads `Colts`.
  //
  // The deliberate -1s are NOT touched: a genuinely welded two-line component
  // gets votes from both lines, is put in `contested`, and stays shared on
  // purpose (the block above says so). Only components with no vote at all are
  // claimed here — the ones nothing has an opinion about.
  //
  // WHAT CLAIMS THEM is proximity to ink that IS owned, not to a baseline. A
  // severed descender is directly under its own letter and merely near the line
  // below; the baseline test cannot tell those apart (the tail's bottom sits
  // closer to the next baseline than to its own), while "whose letter is this
  // touching" answers it exactly. Horizontal overlap is required for the same
  // reason the diacritic pass requires it: a mark belongs to the letter it sits
  // over, not to whatever happens to be at that height.
  {
    const claimed: number[] = [];
    for (let c = 0; c < ccOwner.length; c++) {
      if (ccOwner[c] >= 0 || voted[c]) continue;          // owned, or deliberately shared
      const cx0 = ccMinX[c], cx1 = ccMaxX[c];
      let bestL = -1, bestD = Infinity;
      for (let d = 0; d < ccOwner.length; d++) {
        if (d === c || ccOwner[d] < 0) continue;
        // horizontal overlap, or within a third of an x-height of one
        const ox = Math.max(cx0, ccMinX[d]) - Math.min(cx1, ccMaxX[d]);
        if (ox > xh * 0.33) continue;
        // vertical distance between the two components' nearest edges
        const vg = ccMinY[d] > ccMaxY[c] ? ccMinY[d] - ccMaxY[c]
          : ccMinY[c] > ccMaxY[d] ? ccMinY[c] - ccMaxY[d] : 0;
        if (vg > gap * 0.5) continue;                     // not a neighbour at all
        if (vg < bestD) { bestD = vg; bestL = ccOwner[d]; }
      }
      if (bestL >= 0) { ccOwner[c] = bestL; claimed.push(c); }
    }
    if (claimed.length) nClaimed = claimed.length;
  }

  // A masked component's anti-aliased HALO must go with it, or every whitened
  // line survives as a legible hollow ghost. For each pixel: the owner of the
  // nearest labelled ink within r=2, with own/unclaimed winning ties (never
  // whiten what might be ours).
  const nearOwnerAt = (p: number, line: number): number => {
    const px = p % pageW, py = (p / pageW) | 0;
    let foreign = -1;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= pageH) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = px + dx;
        if (xx < 0 || xx >= pageW) continue;
        const c = ccLabel[yy * pageW + xx];
        if (c < 0) continue;
        const own = ccOwner[c];
        if (own < 0 || own === line) return line;   // own/unclaimed ink nearby: keep
        foreign = own;
      }
    }
    return foreign;   // -1 = no ink nearby, >=0 = only foreign ink nearby
  };

  // RECOGNIZER OVERRIDES win over every verdict above: an override names a
  // component by a pixel inside it and the line the decode preferred.
  if (overrides) {
    for (const o of overrides) {
      if (o.x < 0 || o.y < 0 || o.x >= pageW || o.y >= pageH) continue;
      const c = ccLabel[o.y * pageW + o.x];
      if (c >= 0) ccOwner[c] = o.line;
    }
  }
  return { ccLabel, ccOwner, ccMinX, ccMaxX, ccMinY, ccMaxY, gap, claimed: nClaimed, cut: nCut, nearOwnerAt, twoLine };
}

/**
 * The ownership verdicts as a flat per-pixel mask for `passB.levelWords`
 * (`rec.line` id + 1; 0 = keep). Owned ink takes its owner; unclaimed/shared
 * ink stays 0 — kept in every crop, the band cutter's own conservatism. Halo:
 * a non-ink pixel near ink of exactly ONE owner takes that owner (so a crop
 * whitens a foreign stroke's anti-aliased fringe with the stroke); near mixed
 * or unclaimed ink it stays 0.
 */
export function ownershipMask(own: ComponentOwnership, pageW: number, pageH: number): Int16Array {
  const { ccLabel, ccOwner } = own;
  const mask = new Int16Array(pageW * pageH);
  for (let p = 0; p < pageW * pageH; p++) {
    const c = ccLabel[p];
    if (c >= 0 && ccOwner[c] >= 0) mask[p] = ccOwner[c] + 1;
  }
  // Halo: r=2 dilation of single-owner ink into unlabelled pixels.
  //
  // SEPARABLE, because the combining rule is a semilattice — "no ink" is the
  // identity, two different owners (or any unclaimed ink) collapse to MIXED,
  // and it is associative, commutative and idempotent. So the 5x5 window is
  // the horizontal 5-window of the vertical 5-windows. And STAMPED rather than
  // gathered: the same joins accumulate whether a pixel pulls its five
  // neighbours in or each ink cell pushes its value out to the five pixels
  // that see it — so each pass touches only the cells that carry a value (ink
  // in the first, its horizontal halo in the second) instead of every pixel
  // five times. Same verdict for every pixel; the work scales with the ink.
  const MIXED = -1;
  const N = pageW * pageH;
  const join = (a: number, b: number): number => (
    a === 0 ? b : b === 0 ? a : (a === MIXED || b === MIXED || a !== b) ? MIXED : a);
  const hz = new Int16Array(N);
  for (let y = 0; y < pageH; y++) {
    const row = y * pageW;
    for (let x = 0; x < pageW; x++) {
      const c = ccLabel[row + x];
      if (c < 0) continue;
      const v = ccOwner[c] >= 0 ? ccOwner[c] + 1 : MIXED;
      const x0 = x - 2 < 0 ? 0 : x - 2;
      const x1 = x + 2 >= pageW ? pageW - 1 : x + 2;
      for (let xx = x0; xx <= x1; xx++) hz[row + xx] = join(hz[row + xx], v);
    }
  }
  const vz = new Int16Array(N);
  for (let y = 0; y < pageH; y++) {
    const row = y * pageW;
    const y0 = y - 2 < 0 ? 0 : y - 2;
    const y1 = y + 2 >= pageH ? pageH - 1 : y + 2;
    for (let x = 0; x < pageW; x++) {
      const v = hz[row + x];
      if (v === 0) continue;
      for (let yy = y0; yy <= y1; yy++) vz[yy * pageW + x] = join(vz[yy * pageW + x], v);
    }
  }
  const out = Int16Array.from(mask);
  for (let p = 0; p < N; p++) {
    if (ccLabel[p] >= 0) continue;    // real ink keeps its own verdict
    const v = vz[p];
    if (v > 0) out[p] = v;
  }
  return out;
}

/**
 * NOTHING MARK-SIZED MAY VANISH: a mark the mask would render NOWHERE is
 * released to UNCLAIMED instead.
 *
 * The ownership mask decides which crop may keep a pixel; it cannot put a
 * pixel into a crop whose rectangle never covered it. A decode BAND spans its
 * whole line, so an owned mark always lands somewhere — but word rectangles
 * are spottier: a deep-dipping comma owned by the line BELOW, covered only by
 * the line ABOVE's word rectangles, was whitened out of every crop that saw
 * it and rendered by none ("many marks are now removed entirely"; ocrlab's
 * page view never loses one because a page shows every pixel once).
 *
 * So, per mark-sized component owned by line L: if no rectangle of a line-L
 * word fully contains it, its ownership is DOWNGRADED to unclaimed — the
 * crops that do cover it keep it, exactly where the writer put it (for the
 * deep comma that is the word it trails). Growing the covering word's box was
 * tried first and is a measured NEGATIVE (photo 23 -> 36 errors): the decode's
 * component votes are box-driven, so an expanded box votes on the next line's
 * ascenders and the bands shift under the reader. This touches only `ccOwner`
 * — call it on the cleanPage-side instance; page.mjs computes its own
 * instance for the bands and must NOT release (a band always covers its line).
 *
 * Letters need none of this: their votes come from the very rectangles that
 * cover them. Returns how many components were released.
 */
export function releaseUncoveredMarks(
  own: ComponentOwnership,
  recs: WordRec[],
): number {
  const { ccOwner, ccMinX, ccMaxX, ccMinY, ccMaxY, gap } = own;
  const byLine = new Map<number, WordRec[]>();
  for (const r of recs) {
    if (!byLine.has(r.line)) byLine.set(r.line, []);
    byLine.get(r.line)!.push(r);
  }
  let released = 0;
  for (let c = 0; c < ccOwner.length; c++) {
    const line = ccOwner[c];
    if (line < 0) continue;
    const h = ccMaxY[c] - ccMinY[c] + 1, w = ccMaxX[c] - ccMinX[c] + 1;
    if (h > gap * 0.5 || w > gap * 0.9) continue;   // mark-sized only
    let covered = false;
    for (const r of byLine.get(line) ?? []) {
      if (ccMinX[c] >= r.x0 && ccMaxX[c] <= r.x1 && ccMinY[c] >= r.y0 && ccMaxY[c] <= r.y1) {
        covered = true;
        break;
      }
    }
    if (!covered) { ccOwner[c] = -1; released++; }
  }
  return released;
}

/**
 * A WORD'S CROP MUST COVER ITS OWN DESCENDERS.
 *
 * The segmenter's word box stops where `separateCrossLine` cut a descender
 * that approached the line below, so the crop rectangle ends just under the
 * baseline and chops the g/y/p loops mid-stroke (doppelgänger's g's) — the
 * ink is in segPage, owned by the right line, and simply outside the
 * rectangle. Grow each rec's CROP bounds (x0..y1 — what `levelWords` cuts)
 * to cover every component its own line owns whose x-centre falls inside the
 * word; the ownership mask keeps the foreign ink the bigger rectangle now
 * overlaps out of the render.
 *
 * The DECODE keeps reading the pristine rectangle: callers snapshot it into
 * `rec.voteBox` before this runs, and every vote/band/gate reads
 * `voteBox ?? rec` — growing the voting boxes instead was a measured negative
 * (photo 23 -> 36 errors). Returns how many recs grew.
 */
export function extendCropsToOwnedInk(
  own: ComponentOwnership,
  recs: WordRec[],
  pageW: number,
  pageH: number,
): number {
  const { ccOwner, ccMinX, ccMaxX, ccMinY, ccMaxY } = own;
  const byLine = new Map<number, WordRec[]>();
  for (const r of recs) {
    if (!byLine.has(r.line)) byLine.set(r.line, []);
    byLine.get(r.line)!.push(r);
  }
  const PAD = 2;
  // A trailing mark (the deep comma) sits just RIGHT of its word's rectangle,
  // so a small x margin admits it as this word's to cover — 0.6 xh, the same
  // tightness the deep-trailing claim itself requires.
  const margin = own.gap * 0.45 * 0.6;
  const grew = new Set<WordRec>();
  for (let c = 0; c < ccOwner.length; c++) {
    const line = ccOwner[c];
    if (line < 0) continue;
    const ws = byLine.get(line);
    if (!ws?.length) continue;
    const cx = (ccMinX[c] + ccMaxX[c]) / 2;
    let best: WordRec | null = null;
    let bestOv = -Infinity;
    for (const r of ws) {
      if (cx < r.x0 - margin || cx > r.x1 + margin) continue;
      const ov = Math.min(r.x1, ccMaxX[c]) - Math.max(r.x0, ccMinX[c]);
      if (ov > bestOv) { bestOv = ov; best = r; }
    }
    if (!best) continue;
    if (ccMinX[c] >= best.x0 && ccMaxX[c] <= best.x1
      && ccMinY[c] >= best.y0 && ccMaxY[c] <= best.y1) continue;
    {
      const t = (globalThis as { __sepTrace?: [number, number, number, number] }).__sepTrace;
      if (t && best.x1 >= t[0] && best.x0 <= t[2] && best.y1 >= t[1] && best.y0 <= t[3]) {
        console.log(`[extend] rec x${best.x0}-${best.x1} y${best.y0}-${best.y1} line=${line} grows for comp ${c} x${ccMinX[c]}-${ccMaxX[c]} y${ccMinY[c]}-${ccMaxY[c]}`);
      }
    }
    best.x0 = Math.max(0, Math.min(best.x0, ccMinX[c] - PAD));
    best.x1 = Math.min(pageW - 1, Math.max(best.x1, ccMaxX[c] + PAD));
    best.y0 = Math.max(0, Math.min(best.y0, ccMinY[c] - PAD));
    best.y1 = Math.min(pageH - 1, Math.max(best.y1, ccMaxY[c] + PAD));
    grew.add(best);
  }
  return grew.size;
}
