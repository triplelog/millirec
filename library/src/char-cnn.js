// MillirecCharCnn — the core runtime (library/src/char-cnn-core.js) plus a
// drawing pad: attach(el) mounts a canvas and fires 'millirec:result' after
// each stroke. ~1.7 KB more than the core; use the core if you capture strokes.
import { MillirecCharCnnCore } from './char-cnn-core.js'
import { createDrawCanvas } from '../../widget/canvas.js'

export class MillirecCharCnn extends MillirecCharCnnCore {
  /**
   * Mount a drawing pad in `el`; fires 'millirec:result' ({results, strokes})
   * after each stroke, and 'millirec:clear' ({reason, undo}) when the pad
   * drops its own ink.
   *
   * The pad reads ONE character, so by default writing in it after a pause
   * starts a fresh one (`idleOverwrite`, seconds — 0 turns it off) and
   * scribbling over it throws it away (`scribbleClear`). Both are measured:
   * see widget/canvas.js and scripts/verify-scribble.mjs.
   */
  attach(el, { width = 240, height = 240, ink = '#1e293b', idleOverwrite = 2, scribbleClear = true, scribble = null, staleAlpha, onStale } = {}) {
    const pad = createDrawCanvas({
      width, height, ink, idleOverwrite, scribbleClear, scribble, onStale, ...(staleAlpha === undefined ? {} : { staleAlpha }),
      onClear: (reason) => el.dispatchEvent(new CustomEvent('millirec:clear', { detail: { reason, undo: () => pad.undoClear() } })),
      onStrokeEnd: async (strokes) => {
        // An empty pad reports too: the cell was scribbled out or erased, and
        // a caller left holding the last reading shows a letter that is gone.
        if (!strokes.length) { el.dispatchEvent(new CustomEvent('millirec:result', { detail: { results: [], strokes: [] } })); return }
        const results = await this.recognize(strokes)
        el.dispatchEvent(new CustomEvent('millirec:result', { detail: { results, strokes } }))
      },
    })
    el.appendChild(pad.el)
    return { clear: pad.clear, undoClear: pad.undoClear, isStale: pad.isStale, configure: pad.configure, setInk: pad.setInk, repaint: pad.repaint, getStrokes: pad.getStrokes, canvas: pad.el }
  }
}

if (typeof window !== 'undefined' && typeof __MILLIREC_ESM__ === 'undefined') window.MillirecCharCnn = MillirecCharCnn
