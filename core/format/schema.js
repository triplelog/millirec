// Versioned training-data format.
//
// v1 (legacy, still everywhere): { class: [sample, ...], ... } where a sample
// is either a delta-encoded stroke {x:[Δ...], y:[Δ...]} or a preprocessed
// oriented point cloud [{x,y,s,c}, ...] (image-only).
//
// v2 wraps the same samples with room for everything the library builder
// needs — per-class geometry (baselines/sizes, filled in later from
// collect-server-style data), word lists, and per-library matcher params:
//
//   {
//     version: 2,
//     mode: 'stroke' | 'image' | 'both',
//     pointsPerShape: 50,
//     classes: {
//       "a": {
//         samples: [ {x:[Δ...], y:[Δ...]} | [{x,y,s,c}, ...], ... ],
//         geometry: null | { baseline, top, bottom, width, sigma? }
//                   // x-height units, the wordseg/collect export convention
//       },
//     },
//     wordList: [ ... ],           // optional
//     params: { alpha, beta, ... } // optional per-library matcher overrides
//     ext: { ... }                 // free extension bag
//   }
//
// Decoders MUST tolerate unknown keys at every level so future data (or
// third-party additions) never breaks old runtimes.

export const FORMAT_VERSION = 2

export const isCloudSample = (sample) => Array.isArray(sample)

const isSample = (s) =>
  isCloudSample(s) ? s.every((p) => typeof p?.x === 'number' && typeof p?.y === 'number')
    : Array.isArray(s?.x) && Array.isArray(s?.y) && s.x.length === s.y.length

/** Is this a legacy v1 training object ({class: [samples]})? */
export function isV1(json) {
  return !!json && typeof json === 'object' && !json.version && !json.classes &&
    Object.values(json).every(Array.isArray)
}

/** Wrap a v1 training map in the v2 envelope. */
export function migrateV1(v1, { mode = 'both' } = {}) {
  const classes = {}
  for (const [cls, samples] of Object.entries(v1)) classes[cls] = { samples, geometry: null }
  return { version: FORMAT_VERSION, mode, pointsPerShape: 50, classes, ext: {} }
}

/** Structural errors in a v2 object; [] when valid. */
export function validate(data) {
  const errors = []
  if (!data || typeof data !== 'object') return ['not an object']
  if (typeof data.version !== 'number' || data.version < 2) errors.push('bad version')
  if (!data.classes || typeof data.classes !== 'object' || !Object.keys(data.classes).length) {
    errors.push('no classes')
    return errors
  }
  for (const [cls, entry] of Object.entries(data.classes)) {
    if (!Array.isArray(entry?.samples) || !entry.samples.length) {
      errors.push(`class ${cls}: no samples`)
      continue
    }
    entry.samples.forEach((s, i) => { if (!isSample(s)) errors.push(`class ${cls} sample ${i}: bad shape`) })
    const g = entry.geometry
    if (g != null && typeof g !== 'object') errors.push(`class ${cls}: bad geometry`)
  }
  if (data.wordList != null && !Array.isArray(data.wordList)) errors.push('bad wordList')
  if (data.params != null && typeof data.params !== 'object') errors.push('bad params')
  return errors
}

/**
 * Accept v1 or v2 JSON and return a normalized v2 object. Throws on
 * structural errors. Unknown keys are preserved untouched.
 */
export function decode(json) {
  const data = isV1(json) ? migrateV1(json) : json
  const errors = validate(data)
  if (errors.length) throw new Error('invalid training data: ' + errors.join('; '))
  if (!data.mode) data.mode = 'both'
  if (!data.pointsPerShape) data.pointsPerShape = 50
  if (!data.ext) data.ext = {}
  return data
}

/** Serialize v2 data; version:1 emits the legacy {class: [samples]} map. */
export function encode(data, { version = FORMAT_VERSION } = {}) {
  if (version === 1) return samplesMap(data)
  return data
}

/** The legacy v1 view of a v2 object: {class: [samples]}. */
export function samplesMap(data) {
  const out = {}
  for (const [cls, entry] of Object.entries(data.classes)) out[cls] = entry.samples
  return out
}
