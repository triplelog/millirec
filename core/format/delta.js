// Delta point codec — the recognizer's native stroke-sample encoding.
// A sample is {x: [Δ...], y: [Δ...]}: 50 resampled points, integer deltas,
// first value absolute.

/** Decode a delta-encoded sample into absolute {x,y} points. */
export function decodeSample(sample) {
  const points = []
  let x = 0
  let y = 0
  for (let i = 0; i < sample.x.length; i++) {
    x += sample.x[i]
    y += sample.y[i]
    points.push({ x, y })
  }
  return points
}

/** Encode absolute {x,y} points into a delta sample (rounded to integers). */
export function encodeSample(points) {
  const xs = []
  const ys = []
  let last = [0, 0]
  for (let i = 0; i < points.length; i++) {
    const x = Math.round(points[i].x)
    const y = Math.round(points[i].y)
    xs.push(i === 0 ? x : x - last[0])
    ys.push(i === 0 ? y : y - last[1])
    last = [x, y]
  }
  return { x: xs, y: ys }
}
