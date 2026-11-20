// HAND-EDITING WHICH PIXELS ARE TEXT.
//
// The segmenter decides what counts as ink twice: an absolute darkness bar
// (`inkDark` below the page's paper level) and then a gate that drops whole
// components — too faint, dot-sized with no letter under them, too tall, too
// wide-and-thin, inside the margin. Both decisions are right on average and
// wrong on some blob of every hard page, and when they are wrong the ink is
// simply GONE: it is not in `segPage`, so no decoder can recover it and no
// per-word editor can show it.
//
// This module is the manual override. A page-sized paint mask says, per pixel:
//
//   PAINT_ADD  — count anything DARKISH here as ink, and never drop a
//                component that touches it, whatever the gates say.
//   PAINT_CUT  — this is not text. Erase it before anything looks.
//
// The mask lives in PAGE coordinates (`pass.pageW x pass.pageH`, the frame
// `segPage` and the rec boxes are in), which is also the frame both paint UIs
// draw on. That space is a deterministic function of (source pixels, Pass A
// options), so a mask stays valid across re-runs of the same photo with the
// same options and MUST be discarded when either changes — `inkPaintKey`
// exists to make that check cheap.

import type { WordRec } from './passB/pipeline';

export const PAINT_NONE = 0;
export const PAINT_ADD = 1;
export const PAINT_CUT = 2;

/** A per-pixel paint mask in page coordinates, plus how dark "darkish" is. */
export interface InkPaint {
  /** `pageW * pageH` of PAINT_NONE / PAINT_ADD / PAINT_CUT. */
  mask: Uint8Array;
  w: number;
  h: number;
  /**
   * How far below the page's paper level a pixel inside a PAINT_ADD stroke has
   * to be to count as ink, replacing the page-wide `inkDark` (50) there. The
   * default is deliberately generous: the whole point of painting is that the
   * ordinary bar already refused this ink, and the paint stroke is the
   * writer's assertion that everything darkish inside it belongs to the text.
   * The stroke is the precision, not the threshold.
   */
  darkish?: number;
}

/**
 * Default `darkish`: half of `ccWordBoxes`' page-wide `inkDark` (50).
 *
 * The band this has to reach is the one the page-wide bar throws away — ink
 * between 0 and 50 below paper. Real light-pen ink lands in its upper half
 * (photorain's chewed b-bowl arc measures 40-95 below a paper of 255), while
 * the flattened page's own texture stays within about 10. Half the bar sits
 * between the two.
 *
 * Going lower was tried, at 16, and the cost is visible rather than
 * theoretical: a 34 px brush over one word on photorain admitted enough paper
 * texture to decode two extra words beside it ("i." and "a"). A brush stroke
 * covers blank paper as well as ink — that is what makes it comfortable to
 * aim — so the threshold cannot rely on the stroke being tight.
 */
export const PAINT_DARKISH = 25;

export function makeInkPaint(w: number, h: number, darkish?: number): InkPaint {
  return { mask: new Uint8Array(w * h), w, h, darkish };
}

/** True when nothing has been painted — callers skip the whole feature. */
export function inkPaintEmpty(paint: InkPaint | undefined | null): boolean {
  if (!paint) return true;
  for (let i = 0; i < paint.mask.length; i++) if (paint.mask[i]) return false;
  return true;
}

/**
 * A cheap identity for the (image, options) pair a mask was painted against.
 * Page coordinates only mean something relative to one Pass A run, so a UI
 * holding a mask across a re-import compares this and drops the mask when it
 * differs rather than pasting last photo's strokes onto this one.
 */
export function inkPaintKey(label: string, w: number, h: number, opts: unknown): string {
  return `${label}|${w}x${h}|${JSON.stringify(opts ?? null)}`;
}

/**
 * Stamp a round brush along the segment (x0,y0)-(x1,y1) into the mask.
 *
 * Segment rather than point because a pointermove at any real speed skips
 * pixels, and a brush that skips pixels leaves the stroke it was meant to
 * cover full of holes — which for THIS mask means half a letter admitted.
 */
export function stampBrush(
  paint: InkPaint,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: number,
): void {
  const { mask, w, h } = paint;
  const r = Math.max(0.5, radius);
  const r2 = r * r;
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const bx1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const by1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      // distance from the pixel centre to the segment
      let t = len2 > 0 ? ((x - x0) * dx + (y - y0) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x0 + t * dx - x;
      const py = y0 + t * dy - y;
      if (px * px + py * py <= r2) mask[y * w + x] = value;
    }
  }
}

/**
 * Apply the DESTRUCTIVE half of the paint to the segmentation page, in place.
 *
 * Two things happen here rather than inside `ccWordBoxes`, because both are
 * about what the page IS, not about how components are judged:
 *
 *  - **PAINT_CUT whitens.** Erasing at the source is the whole fix: the pixels
 *    are not ink, they cannot weld two letters into one component, and the
 *    per-character clean render (which reads `gray`, not the ink mask) will
 *    not draw them either. A gate-level "reject this component" could do none
 *    of that.
 *
 *  - **PAINT_ADD un-erases rule removal.** The paint is applied to the
 *    RULE-REMOVED page, and the user is painting on what they can SEE — so
 *    ink the rule remover or its residue passes whitened is dark on screen and
 *    white here, and lowering a threshold over a white pixel recovers nothing.
 *    Inside an ADD stroke the original flattened darkness is restored, EXCEPT
 *    where `ruleCls` says the pixel was erased as a printed rule: painting a
 *    blob back must not paint the rule under it back with it.
 */
export function applyInkPaint(
  gray: Uint8Array,
  w: number,
  h: number,
  paint: InkPaint,
  origGray?: Uint8Array | null,
  ruleCls?: Uint8Array | null,
): void {
  const n = Math.min(gray.length, paint.mask.length, w * h);
  for (let i = 0; i < n; i++) {
    const p = paint.mask[i];
    if (p === PAINT_CUT) {
      gray[i] = 255;
    } else if (p === PAINT_ADD && origGray) {
      if (ruleCls && ruleCls[i] === 1) continue; // erased as a printed rule — leave it erased
      if (origGray[i] < gray[i]) gray[i] = origGray[i];
    }
  }
}

// ── what is currently included ───────────────────────────────────────────────

export const INCL_NONE = 0;
/** In `segPage` — the segmenter accepted it — but no live word rectangle
 *  covers it, so no word carries it and the editor never shows it. */
export const INCL_LOOSE = 1;
/** In `segPage` and inside a live rec: this pixel is part of a word. */
export const INCL_WORD = 2;

/**
 * Per-pixel answer to "is this pixel part of the text right now?", which is the
 * question the paint UI exists to make visible.
 *
 * Deliberately THREE-valued. "Accepted as ink" and "carried by a word" are
 * different failures with different fixes — ink that no rectangle covers is a
 * word-box problem, ink that is not in `segPage` at all is the gate problem
 * painting is for — and a two-colour overlay would show them as the same thing.
 */
export function inclusionMap(
  segPage: Uint8Array,
  w: number,
  h: number,
  recs: readonly WordRec[],
  inkAt = 250,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (segPage[i] < inkAt) out[i] = INCL_LOOSE;
  for (const r of recs) {
    if (r.status === 'empty') continue;
    const x0 = Math.max(0, Math.floor(r.x0));
    const x1 = Math.min(w - 1, Math.ceil(r.x1));
    const y0 = Math.max(0, Math.floor(r.y0));
    const y1 = Math.min(h - 1, Math.ceil(r.y1));
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) if (out[row + x]) out[row + x] = INCL_WORD;
    }
  }
  return out;
}
