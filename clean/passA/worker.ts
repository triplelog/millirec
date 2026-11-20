// Pipeline worker: owns the WASM instance and the current image; runs the
// requested stages per request and streams the requested per-stage RGBA
// previews back (transferred).
//
// ONE WORKER SERVES A WHOLE `cleanPage`. Three things follow from that, and
// each was a measured cost before it did:
//
//   - the image is uploaded into the WASM heap ONCE per `setImage` — 48 MB for
//     a 12-megapixel photo, and `cleanPage` runs Pass A two to four times, so
//     the copy used to be paid on every run (the bytes survive every run:
//     `arena_reset` never touches `g.input`);
//   - a `run` may ask for a STAGE RANGE. The dewarp check only needs stages
//     1-4 to measure the ruled lines' slope on its candidate, and pays for the
//     expensive 5-8 (rule tracing, removal, binarize) only if the candidate
//     wins — as a CONTINUATION, on the state the partial run left in the arena;
//   - a `run` may name which stage previews it wants. The driver reads 4 and
//     8; rendering all eight was six 1.7-megapixel RGBA renders and copies per
//     run that nothing consumed.
//
// Defaults reproduce the old behaviour exactly: stages 1-8, every preview.
import { STAGE_NAMES, defaultParams } from './params';

let modPromise: Promise<any> | null = null;
let image: { w: number; h: number; data: Uint8ClampedArray } | null = null;
/** The image bytes are in the WASM input buffer. Cleared by `setImage`. */
let uploaded = false;
/** Stage-4 (page) dimensions of the last run, for a continuation that starts
 *  past stage 4 and so never sees the preview those are read from. */
let page = { w: 0, h: 0 };

/** Where hw.mjs + hw.wasm are served from. The host app decides: it must copy
 *  them out of the package (see clean/assets/) to somewhere it serves, then
 *  pass that path as `assetBase` on the first message. Defaults to /wasm/. */
let assetBase = '/wasm/';

function getModule(): Promise<any> {
  if (!modPromise) {
    // hw.mjs locates hw.wasm itself, relative to its own URL.
    // The URL is only known at runtime, so every bundler must be told to leave
    // this dynamic import alone (Vite: @vite-ignore, webpack: webpackIgnore,
    // Turbopack/Next: turbopackIgnore) rather than try to statically resolve it.
    const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
    const url = new URL(`${base}hw.mjs`, self.location.origin).href;
    modPromise = import(
      /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url
    ).then((m) => m.default());
  }
  return modPromise;
}

/** Put the current image in the WASM input buffer, once. */
function ensureInput(mod: any): void {
  if (!image) throw new Error('no image loaded');
  if (uploaded) return;
  const ptr = mod._hw_set_input(image.w, image.h);
  if (!ptr) throw new Error('wasm input allocation failed');
  mod.HEAPU8.set(image.data, ptr);
  uploaded = true;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'setImage') {
    // Must arrive before the module is first needed; ignored afterwards, since
    // the module is cached for the worker's lifetime.
    if (msg.assetBase) assetBase = msg.assetBase;
    image = { w: msg.w, h: msg.h, data: new Uint8ClampedArray(msg.rgba) };
    uploaded = false;
    page = { w: 0, h: 0 };
    return;
  }
  if (msg.type === 'detectQuad') {
    try {
      const mod = await getModule();
      ensureInput(mod);
      // Always plain auto-detect for this preview call — never manual.
      mod.HEAPF32.set(defaultParams(), mod._hw_params() >> 2);

      mod._hw_run_stage(1);
      mod._hw_run_stage(2);
      // the quad's frame is the working gray; its size is exported directly
      // (rendering the stage-2 preview just to read the size off it was a
      // 1.7-megapixel RGBA render per call)
      let grayW: number, grayH: number;
      if (typeof mod._hw_gray_w === 'function') { grayW = mod._hw_gray_w(); grayH = mod._hw_gray_h(); }
      else { mod._hw_preview(2); grayW = mod._hw_preview_w(); grayH = mod._hw_preview_h(); }
      const qp = mod._hw_quad() >> 2;
      const quad = Array.from(mod.HEAPF32.subarray(qp, qp + 8));
      const quadFound = !!mod._hw_quad_found();
      // `quadFound` alone has never been enough: the detector reports success on
      // any four corners it can fit, including the image border. `quadScore` is
      // how much real paper edge sits under them, and `quadReject` says why when
      // there is no quad at all.
      (self as any).postMessage({
        type: 'quad', quad, quadFound, grayW, grayH,
        quadScore: mod._hw_quad_score(),
        quadReject: mod._hw_quad_reject(),
        quadOverflow: !!mod._hw_quad_overflow(),
      });
    } catch (err: any) {
      (self as any).postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
    return;
  }
  if (msg.type !== 'run') return;

  try {
    const mod = await getModule();
    ensureInput(mod);
    mod.HEAPF32.set(Float32Array.from(msg.params), mod._hw_params() >> 2);

    // The stage range and the previews wanted. A continuation (`from` > 1)
    // runs on whatever the previous run left in the arena — the caller's
    // contract is that it follows a run of the stages below `from` with the
    // same parameters and no other run in between.
    const from = Math.max(1, Math.min(8, Number(msg.stages?.[0] ?? 1) | 0));
    const to = Math.max(from, Math.min(8, Number(msg.stages?.[1] ?? 8) | 0));
    const wanted: Set<number> | null = Array.isArray(msg.previews) ? new Set(msg.previews.map(Number)) : null;

    for (let s = from; s <= to; s++) {
      const t0 = performance.now();
      if (s === 2 && msg.manualQuad) {
        mod.HEAPF32.set(Float32Array.from(msg.manualQuad), mod._hw_quad() >> 2);
      }
      const rc = mod._hw_run_stage(s);
      if (rc !== 0)
        throw new Error(`stage ${s} (${STAGE_NAMES[s]}) failed, rc=${rc}`);
      const ms = performance.now() - t0;
      if (wanted && !wanted.has(s)) {
        // Not wanted — but the page dimensions come from stage 4, and a
        // caller that skips its preview still needs them for the rule traces.
        if (s === 4) {
          if (typeof mod._hw_page_w === 'function') page = { w: mod._hw_page_w(), h: mod._hw_page_h() };
          else { mod._hw_preview(4); page = { w: mod._hw_preview_w(), h: mod._hw_preview_h() }; }
        }
        continue;
      }
      const p = mod._hw_preview(s);
      if (p) {
        const w = mod._hw_preview_w();
        const h = mod._hw_preview_h();
        if (s === 4) page = { w, h };
        const rgba = mod.HEAPU8.slice(p, p + w * h * 4).buffer;
        (self as any).postMessage({ type: 'stage', stage: s, w, h, rgba, ms }, [rgba]);
      }
    }
    const pageW = page.w, pageH = page.h;

    // Full rule traces (page coordinates) so the UI can export a rules JSON
    // consumable by downstream per-word tools. Only meaningful once stage 5
    // has run; a partial run below it reports none.
    const ruleData: { thickness: number; y: number[] }[] = [];
    const vruleData: { thickness: number; x: number[] }[] = [];
    if (to >= 5) {
      for (let r = 0; r < mod._hw_rule_count(); r++) {
        const y = new Array<number>(pageW);
        for (let x = 0; x < pageW; x++) y[x] = mod._hw_rule_y_at(r, x);
        ruleData.push({ thickness: mod._hw_rule_thick(r), y });
      }
      for (let r = 0; r < mod._hw_vrule_count(); r++) {
        const x = new Array<number>(pageH);
        for (let y = 0; y < pageH; y++) x[y] = mod._hw_vrule_x_at(r, y);
        vruleData.push({ thickness: mod._hw_vrule_thick(r), x });
      }
    }

    (self as any).postMessage({
      pageW,
      pageH,
      ruleData,
      vruleData,
      type: 'done',
      stages: [from, to],
      quadFound: !!mod._hw_quad_found(),
      quadScore: mod._hw_quad_score(),
      quadReject: mod._hw_quad_reject(),
      quadOverflow: !!mod._hw_quad_overflow(),
      rules: to >= 5 ? mod._hw_rule_count() : 0,
      vrules: to >= 5 ? mod._hw_vrule_count() : 0,
      lineHeight: to >= 5 ? mod._hw_line_height() : 0,
      bestPair: to >= 5 && mod._hw_best_pair_ea() > 0
        ? {
            a: mod._hw_best_pair_a(),
            b: mod._hw_best_pair_b(),
            ea: mod._hw_best_pair_ea(),
            eb: mod._hw_best_pair_eb(),
          }
        : null,
    });
  } catch (err: any) {
    (self as any).postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
