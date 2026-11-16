// Shared pipeline constants and the per-mode matcher parameter table.
// This file is THE source the worker tails, library templates, and tuning
// docs derive from — a parameter change lands here and nowhere else.

export const POINTS_PER_SHAPE = 50
export const SECOND_AVERAGE = 1000

// Swept Jul 16 2026 via tuning/sweep.cjs (see tuning/EXPERIMENTS.md):
//   stroke — 100% leave-one-out on the default symbol set
//   image  — α REBALANCED Jul 25 2026. α had never been retuned after the
//            curvature term shipped, leaving orientation at only 8% of each
//            pair's cost against curvature's 49%. A joint α×γ sweep against
//            real word photos (training/words2 + words3, held out) found a
//            broad optimum at α=5 γ=3: mean raw CER 43.2% → 12.15% and MNIST
//            held-out top-1 93.6% → 94.8% (SSE 106 → 59). β / maxCost /
//            outliersMul were swept over a full 27-cell cross at the new α and
//            were already optimal — maxCost is nearly inert (0% of true-class
//            pairs clip) and outliersMul=2 is sharply best. Curvature still
//            earns its slot: γ→0 at α=5 is 21.9% raw CER vs 12.15% with γ=3.
//            Previous shipped setting was α=0.4 γ=2 (93.6% MNIST).
// kappaGamma > 0 turns on the per-point curvature cost term (worker uploads
// tanh(k/KAPPA0) via addPointK and calls setKappaGamma after firstCall).
export const MODE_PARAMS = {
  stroke: { alpha: 1, beta: 0.003, maxCost: 30, divi: 1, outliersMul: 1, outlierCost: 0, scoreMode: 0, kappaGamma: 0, gateScale: 1 },
  image: { alpha: 5, beta: 0.002, maxCost: 90, divi: 1, outliersMul: 2, outlierCost: 0, scoreMode: 0, kappaGamma: 3, gateScale: 0.6 },
}

/**
 * Cost-gate radius, as a fraction of the radius at which beta*ddis alone
 * provably reaches maxCost. 1 = exact (bit-identical output); below that,
 * distant pairs are written as maxCost without being computed.
 *
 * Mode-dependent ON PURPOSE. Measured against tuning/golden.json:
 *   image  0.6 is the largest value that reproduces golden EXACTLY. 0.4 keeps
 *          top1 at 94.8 but drifts top3 99.4->99.2 and sse 59->64; 0.3 drops
 *          top1 to 93.8. Speed falls off with the radius, so the
 *          golden-clean setting is worth only a few percent — see below.
 *   stroke regresses at EVERY aggressive value tested (0.7 -> 98.11,
 *          0.3 -> 96.23), so it stays exact. outliersMul=1 gives it half
 *          the outlier slots of image, so it cannot absorb gated pairs.
 * A value safe at pps=100 is not automatically safe at pps=50 — sparser
 * clouds put fewer candidates inside the same radius.
 */

// tanh squash scale for the curvature feature (κ/kappa0); only meaningful
// when kappaGamma > 0. Best sweep value, see tuning/CURVATURE.md.
export const KAPPA0 = 0.02
