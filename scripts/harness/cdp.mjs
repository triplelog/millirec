// A tiny DevTools-protocol harness: launch headless Chrome, open pages, run
// JS in them, screenshot. verify-games.mjs drives every word game through it
// — no Chrome extension, no puppeteer: node 22's WebSocket + the installed
// Google Chrome. `PEN` is page-side: it writes a capital letter into a box
// with synthetic PointerEvents on the surface's canvas (pointer capture is
// try/caught in inkgrid.js, coalesced events fall back), so a drawn L over
// CORE reads as LORE. The straight-line letters read reliably; M reads as N.
// With several pages open, `page.front()` before a pen write: the hidden
// page's timers are throttled and a commit-on-pause may never come.
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let launches = 0
export async function launch() {
  launches++
  // a fresh profile per launch, deleted on close: a full games run launches Chrome ~25 times and the profiles once filled the disk
  const profile = `${process.env.TMPDIR || '/tmp'}/millirec-cdp-profile-${process.pid}-${launches}`
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--window-size=1280,900',
    // a long run stalled twice on a page-side promise that never resolved — Chrome throttles and can FREEZE background tabs; these keep every tab's timers live
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-ipc-flooding-protection', '--disable-features=TabFreezing,IntensiveWakeUpThrottling', 'about:blank'], { stdio: 'ignore' })
  const exited = new Promise((r) => proc.once('exit', r))
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(200) } }
  const pages = []
  const session = {
    async page({ width = 1280, height = 900, mobile = false, dark = false } = {}) {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((r) => (ws.onopen = r))
      let id = 0
      const pending = new Map(), console_ = [], loads = []
      ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('page connection closed')); pending.clear() }
      ws.onerror = () => { for (const { rej } of pending.values()) rej(new Error('page connection error')); pending.clear() }
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result) }
        if (d.method === 'Runtime.consoleAPICalled') console_.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
        if (d.method === 'Runtime.exceptionThrown') console_.push('EXCEPTION: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text))
        if (d.method === 'Page.loadEventFired') for (const r of loads.splice(0)) r()
      }
      // A reply that never comes is a HANG, not a failure: a full gate once sat 94 minutes at 0% CPU on one command. Every command times out.
      const CDP_MS = Number(process.env.CDP_MS) || 180000
      const send = (method, params = {}) => new Promise((res, rej) => {
        const i = ++id
        const t = setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP timeout after ${CDP_MS / 1000} s: ${method}`)) } }, CDP_MS)
        pending.set(i, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
        ws.send(JSON.stringify({ id: i, method, params }))
      })
      await send('Page.enable'); await send('Runtime.enable')
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
      if (dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
      const page = {
        console: console_,
        async goto(url) { const loaded = new Promise((r) => loads.push(r)); await send('Page.navigate', { url }); await Promise.race([loaded, sleep(15000)]) },
        async eval(expression) {
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
          return r.result.value
        },
        async shot(path, full = false) {
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(full ? { clip: await page.eval(`(() => ({ x: 0, y: 0, width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, scale: 1 }))()`) } : {}) })
          writeFileSync(path, Buffer.from(r.data, 'base64')); return path
        },
        /** Make this the visible target: a HIDDEN page's timers are throttled (a 100 ms timer measured 512–970 ms, inkgrid's commit timer sometimes never fired), so call it before the pen writes on a page when several are open. */
        async front() { await send('Page.bringToFront') },
        async size({ width, height, mobile = false }) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile }) },
        async waitFor(expression, ms = 20000) {
          const t0 = Date.now()
          while (Date.now() - t0 < ms) { if (await page.eval(expression)) return true; await sleep(250) }
          throw new Error('timeout waiting for ' + expression)
        },
        async close() { ws.close(); try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`, { signal: AbortSignal.timeout(5000) }) } catch {} },
      }
      pages.push(page)
      return page
    },
    /** Close every page and the browser, and WAIT until the debug port stops answering — a relaunch on the same port must not attach to the dying one. */
    async close() {
      for (const p of pages) try { await p.close() } catch {}
      proc.kill()
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(300) }); await sleep(100) } catch { break } }
      // Chrome writes to its profile until the process is gone, so delete after it exits (a deletion before that left the folder behind)
      await Promise.race([exited, sleep(10000)])
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch {}
    },
  }
  return session
}

/** Page-side helper: draw a capital letter into an element with synthetic pen events on the surface's canvas. */
export const PEN = `
window.__pen = (() => {
  const SHAPES = {
    I: [[[.5,.1],[.5,.9]]],
    L: [[[.2,.1],[.2,.9],[.8,.9]]],
    T: [[[.1,.1],[.9,.1]],[[.5,.1],[.5,.9]]],
    V: [[[.1,.1],[.5,.9],[.9,.1]]],
    N: [[[.15,.9],[.15,.1],[.85,.9],[.85,.1]]],
    Z: [[[.1,.1],[.9,.1],[.1,.9],[.9,.9]]],
    E: [[[.8,.1],[.2,.1],[.2,.9],[.8,.9]],[[.2,.5],[.7,.5]]],
    F: [[[.8,.1],[.2,.1],[.2,.9]],[[.2,.5],[.7,.5]]],
    H: [[[.2,.1],[.2,.9]],[[.8,.1],[.8,.9]],[[.2,.5],[.8,.5]]],
    A: [[[.1,.9],[.5,.1],[.9,.9]],[[.25,.6],[.75,.6]]],
    M: [[[.1,.9],[.1,.1],[.5,.65],[.9,.1],[.9,.9]]],
    W: [[[.1,.1],[.3,.9],[.5,.35],[.7,.9],[.9,.1]]],
    X: [[[.1,.1],[.9,.9]],[[.9,.1],[.1,.9]]],
    K: [[[.2,.1],[.2,.9]],[[.8,.1],[.2,.5],[.8,.9]]],
    Y: [[[.1,.1],[.5,.5],[.9,.1]],[[.5,.5],[.5,.9]]],
    C: [(() => { const p=[]; for (let a=0.28*Math.PI; a<=1.72*Math.PI; a+=0.15) p.push([.5+.4*Math.cos(a), .5+.4*Math.sin(a)]); return p })()],
    O: [(() => { const p=[]; for (let a=-0.5*Math.PI; a<=1.55*Math.PI; a+=0.15) p.push([.5+.4*Math.cos(a), .5+.4*Math.sin(a)]); return p })()],
    U: [[[.15,.1],[.15,.65],[.25,.85],[.5,.92],[.75,.85],[.85,.65],[.85,.1]]],
    '1': [[[.5,.1],[.5,.9]]],
    '2': [[[.2,.3],[.3,.15],[.5,.1],[.7,.15],[.8,.3],[.72,.48],[.2,.9],[.85,.9]]],
    '3': [[[.2,.18],[.4,.1],[.65,.12],[.78,.28],[.65,.45],[.45,.5],[.68,.55],[.8,.72],[.62,.9],[.38,.9],[.2,.8]]],
    '4': [[[.65,.1],[.2,.6],[.85,.6]],[[.65,.1],[.65,.92]]],
    '5': [[[.8,.1],[.25,.1],[.22,.48],[.55,.44],[.8,.6],[.75,.82],[.5,.92],[.22,.85]]],
    '6': [[[.72,.1],[.4,.35],[.22,.65],[.3,.86],[.55,.92],[.78,.78],[.72,.58],[.5,.5],[.25,.6]]],
    '7': [[[.15,.12],[.85,.12],[.42,.9]]],
    '8': [[[.5,.5],[.28,.35],[.35,.15],[.5,.1],[.68,.15],[.72,.35],[.5,.5],[.25,.68],[.3,.88],[.5,.92],[.7,.88],[.75,.68],[.5,.5]]],
    '9': [[[.75,.35],[.6,.15],[.38,.15],[.25,.32],[.35,.5],[.6,.52],[.76,.4],[.74,.65],[.62,.85],[.42,.92]]],
    S: [(() => { const p=[]; for (let a=0.1*Math.PI; a<=1.5*Math.PI; a+=0.2) p.push([.5+.22*Math.cos(a), .3+.2*Math.sin(a)]); for (let a=-0.5*Math.PI; a<=0.9*Math.PI; a+=0.2) p.push([.5-.22*Math.cos(a), .7+.2*Math.sin(a)]); return p })()],
    // the code alphabet's two emoji (server/codes.js), drawn as games/scripts/build-code-set.mjs's templates are: a heart from the notch, a pentagram from the top
    '❤': [(() => { const p = []; for (let i = 0; i <= 40; i++) { const t = 2 * Math.PI * i / 40; p.push([.5 + .43 * Math.pow(Math.sin(t), 3), .47 - .034 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]) } return p })()],
    '⭐': [[0, 2, 4, 1, 3, 0].map((k) => [.5 + .46 * Math.cos(-Math.PI / 2 + k * 2 * Math.PI / 5), .52 + .46 * Math.sin(-Math.PI / 2 + k * 2 * Math.PI / 5)])],
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const seg = (pts, n = 10) => { const out = []; for (let i = 0; i + 1 < pts.length; i++) for (let k = 0; k <= n; k++) { const t = k / n; out.push([pts[i][0] + (pts[i+1][0]-pts[i][0]) * t, pts[i][1] + (pts[i+1][1]-pts[i][1]) * t]) } return out }
  const ev = (canvas, type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'pen', isPrimary: true, button: type === 'pointerup' ? 0 : 0, buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : .5 }))
  const strokesIn = (rect, letter) => (SHAPES[letter] || SHAPES.I).map((s) => (s.length > 4 ? s : seg(s)).map(([u, v]) => [rect.left + rect.width * (0.2 + 0.6 * u), rect.top + rect.height * (0.2 + 0.6 * v)]))
  // REAL ink: a drill sample from an overlap training file (25-point resampled polyline, delta-encoded,
  // first value absolute; class → [samples], each with its stroke count) scaled into the box — the
  // writer's own letter, so it reads as the writer's recognizer expects. The resampling dropped the
  // pen-ups but a pen-up is a jump between consecutive points, so a k-stroke sample is cut at its
  // k−1 largest jumps.
  let REAL = null
  const decode = (smp) => { const pts = []; let x = 0, y = 0; for (let i = 0; i < smp.x.length; i++) { x = i ? x + smp.x[i] : smp.x[i]; y = i ? y + smp.y[i] : smp.y[i]; pts.push([x, y]) } return pts }
  const cut = (pts, k) => {
    if (k <= 1) return [pts]
    const gaps = pts.slice(1).map((p, i) => [Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), i + 1]).sort((a, b) => b[0] - a[0]).slice(0, k - 1).map((g) => g[1]).sort((a, b) => a - b)
    const out = []; let from = 0
    for (const b of gaps) { out.push(pts.slice(from, b)); from = b }
    out.push(pts.slice(from))
    return out.filter((st) => st.length)
  }
  return {
    letters: Object.keys(SHAPES),
    async loadReal(url) { REAL = await (await fetch(url)).json(); return Object.keys(REAL.classes).filter((k) => !k.includes('/')) },
    /** Write the writer's own ch (drill sample i) into box, about half the box tall, stroke by stroke; falls back to the synthetic shape when the file has no sample. */
    async real(box, ch, canvas, i = 0) {
      const list = (REAL && REAL.classes[ch]) || []
      canvas = canvas || box.closest('.surface').querySelector(':scope > canvas.over')
      if (!list.length) return this.write(box, ch, canvas)
      const smp = list[i % list.length], pts = decode(smp)
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
      const w = Math.max(1, Math.max(...xs) - Math.min(...xs)), h = Math.max(1, Math.max(...ys) - Math.min(...ys))
      const rect = box.getBoundingClientRect(), k = (rect.height * 0.5) / Math.max(h, w * 0.6)
      const ox = rect.left + rect.width / 2 - (Math.min(...xs) + w / 2) * k, oy = rect.top + rect.height / 2 - (Math.min(...ys) + h / 2) * k
      for (const st of cut(pts.map(([x, y]) => [ox + x * k, oy + y * k]), smp.strokes || 1)) {
        if (st.length === 1) st.push([st[0][0] + 1, st[0][1]])
        ev(canvas, 'pointerdown', st[0][0], st[0][1]); await sleep(8)
        for (const [x, y] of st.slice(1)) { ev(canvas, 'pointermove', x, y); await sleep(4) }
        ev(canvas, 'pointerup', st[st.length - 1][0], st[st.length - 1][1]); await sleep(120)
      }
    },
    /** Write the synthetic shape of letter into box with pointer events on canvas (the box is measured per stroke: a page still scrolling moved a second stroke into the next square once). */
    async write(box, letter, canvas) {
      canvas = canvas || box.closest('.surface').querySelector(':scope > canvas.over')
      const n = (SHAPES[letter] || SHAPES.I).length
      for (let k = 0; k < n; k++) {
        const st = strokesIn(box.getBoundingClientRect(), letter)[k]
        ev(canvas, 'pointerdown', st[0][0], st[0][1]); await sleep(8)
        for (const [x, y] of st.slice(1)) { ev(canvas, 'pointermove', x, y); await sleep(5) }
        ev(canvas, 'pointerup', st[st.length - 1][0], st[st.length - 1][1]); await sleep(120)
      }
    },
    async press(box, canvas) {
      const r = box.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
      canvas = canvas || box.closest('.surface').querySelector(':scope > canvas.over')
      ev(canvas, 'pointerdown', x, y); await sleep(30); ev(canvas, 'pointermove', x + 1, y); await sleep(30); ev(canvas, 'pointerup', x + 1, y)
    },
  }
})()
`
