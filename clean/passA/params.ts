// Tunable pipeline parameters. Array order MUST match the enum in wasm/src/hw.h.

export const STAGE_NAMES = [
  'Input',
  'Grayscale + downscale',
  'Page detection',
  'Perspective correction',
  'Illumination flatten',
  'Rule tracing',
  'Line removal',
  'Binarize (Sauvola)',
  'Despeckle',
];

export interface ParamDef {
  key: string;
  label: string;
  stage: number; // stage index the param belongs to (1..8)
  min: number;
  max: number;
  step: number;
  def: number;
  description: string;
}

export const PARAMS: ParamDef[] = [
  {
    key: 'workMaxDim', label: 'Working resolution', stage: 1,
    min: 600, max: 3000, step: 100, def: 1500,
    description: 'Long-edge size of the working image in pixels. Higher keeps more stroke detail; every stage gets slower.',
  },
  {
    key: 'pageEnable', label: 'Detect page', stage: 2,
    min: 0, max: 1, step: 1, def: 1,
    description: 'Find the paper boundary and crop/warp to it. Off = use the full frame as-is.',
  },
  {
    key: 'pageBlur', label: 'Pre-blur', stage: 2,
    min: 0, max: 8, step: 1, def: 2,
    description: 'Blur radius (at detection scale) before thresholding paper vs background. Raise if background texture creates false paper edges.',
  },
  {
    key: 'pageMorph', label: 'Mask close radius', stage: 2,
    min: 0, max: 10, step: 1, def: 3,
    description: 'Closes holes in the paper mask (binder holes, dark drawings, shadows crossing the edge). Too high rounds off page corners.',
  },
  {
    key: 'pageMinArea', label: 'Min page area', stage: 2,
    min: 0.05, max: 0.9, step: 0.05, def: 0.25,
    description: 'Smallest fraction of the frame the detected page may cover. Below this the detection is rejected and the full frame is used.',
  },
  {
    key: 'illumDown', label: 'Background scale', stage: 4,
    min: 2, max: 16, step: 1, def: 8,
    description: 'Lighting/paper-color background is estimated at 1/N scale. Smaller N follows lighting changes more closely but risks absorbing large dark drawings.',
  },
  {
    key: 'illumKernel', label: 'Ink removal kernel', stage: 4,
    min: 3, max: 31, step: 2, def: 9,
    description: 'Morphological close size (at background scale) that erases ink from the background estimate. Must exceed stroke thickness ÷ background scale; too high smears shadows.',
  },
  {
    key: 'illumStrength', label: 'Flatten strength', stage: 4,
    min: 0, max: 1, step: 0.05, def: 1,
    description: 'Blend between the original (0) and fully illumination-normalized image (1). 1 makes any paper color/shadow uniformly near-white.',
  },
  {
    key: 'ruleKernel', label: 'Min rule length', stage: 5,
    min: 9, max: 121, step: 2, def: 41,
    description: 'Horizontal dark runs shorter than this (px) are treated as text, longer as candidate ruled lines. Raise if long horizontal pen strokes are misread as rules.',
  },
  {
    key: 'ruleThresh', label: 'Rule threshold', stage: 5,
    min: 0.05, max: 0.9, step: 0.05, def: 0.2,
    description: 'How strong a row of line-energy must be, relative to the strongest rule, to count as a rule. Lower finds faint rules; too low invents rules from dense text.',
  },
  {
    key: 'ruleAutoGap', label: 'Auto line spacing', stage: 5,
    min: 0, max: 1, step: 1, def: 1,
    description: 'Estimate the paper\'s line height by probing hundreds of points for the vertical gap between dark pixels (95th percentile), then derive min/max pair spacing as 0.5x/1.5x of it. The manual spacing sliders below are ignored while this is on.',
  },
  {
    key: 'ruleMinGap', label: 'Min rule spacing', stage: 5,
    min: 4, max: 80, step: 1, def: 18,
    description: 'Minimum vertical distance (px) between two rules. Set just below the actual rule spacing of the paper. Ignored when auto line spacing is on.',
  },
  {
    key: 'ruleMaxGap', label: 'Max pair spacing', stage: 5,
    min: 10, max: 200, step: 1, def: 60,
    description: 'Largest gap (px) between two candidate rules traced together as a parallel pair. Ignored when auto line spacing is on.',
  },
  {
    key: 'ruleBand', label: 'Max total drift', stage: 5,
    min: 2, max: 100, step: 1, def: 30,
    description: 'Upper bound (px) on how far a traced rule may end up from its left-edge start (sizes the DP search window). The local slope limit below is what actually shapes the trace.',
  },
  {
    key: 'ruleSlope', label: 'Local slope limit', stage: 5,
    min: 1, max: 20, step: 1, def: 5,
    description: 'Max vertical movement (px) a traced rule may make per 20 horizontal px. Local constraint instead of a global wander band: lower = straighter rules, higher follows page curl more freely.',
  },
  {
    key: 'rulePairSkew', label: 'Pair skew tolerance', stage: 5,
    min: 1, max: 24, step: 1, def: 8,
    description: 'Rules are traced as coupled parallel pairs: the pair\'s vertical gap may drift at most this many px from its value at the left edge. Lower enforces stricter parallelism; higher tolerates warped pages.',
  },
  {
    key: 'ruleMax', label: 'Max rules', stage: 5,
    min: 1, max: 120, step: 1, def: 60,
    description: 'Upper bound on traced horizontal rules.',
  },
  {
    key: 'vruleEnable', label: 'Vertical lines', stage: 5,
    min: 0, max: 1, step: 1, def: 1,
    description: 'Also trace and remove vertical divider/margin lines.',
  },
  {
    key: 'lineDark', label: 'Ink threshold', stage: 6,
    min: 100, max: 250, step: 5, def: 200,
    description: 'After flattening, pixels darker than this count as ink/line when measuring rule thickness. Lower = only strong ink; higher also catches faint lines.',
  },
  {
    key: 'lineMaxThick', label: 'Max rule thickness', stage: 6,
    min: 1, max: 20, step: 1, def: 8,
    description: 'Cap (px) on the automatically measured rule thickness (probed along each traced rule, 90th percentile of uncrossed columns + 2px skirt). The removal band is the measured thickness centered on the trace.',
  },
  {
    key: 'lineDelta', label: 'Outlier darkness Δ', stage: 6,
    min: 5, max: 120, step: 5, def: 40,
    description: 'A band pixel must be at least this much DARKER than the rule\'s expected color (running median of its band row over the window below) to count as text. Lower protects more text; higher removes more aggressively.',
  },
  {
    key: 'lineWindow', label: 'Expected-color window', stage: 6,
    min: 20, max: 300, step: 10, def: 100,
    description: 'Half-width (px) of the sliding window along the seam used to compute each band row\'s expected (median) color. Smaller adapts to local rule fading; larger is more stable under dense writing.',
  },
  {
    key: 'lineExtend', label: 'Run extension', stage: 6,
    min: 1, max: 10, step: 1, def: 2,
    description: 'Second text test: the pixel\'s vertical dark run must extend at least this many px beyond the rule band (a crossing stroke continues; rule pixels don\'t). Only pixels passing BOTH tests are kept as text.',
  },
  {
    key: 'lineInpaint', label: 'Gap blending', stage: 6,
    min: 0, max: 20, step: 1, def: 4,
    description: 'Diffusion iterations that blend erased line pixels into their surroundings, bridging strokes that crossed the rule.',
  },
  {
    key: 'binWindow', label: 'Sauvola window', stage: 7,
    min: 7, max: 101, step: 2, def: 31,
    description: 'Local window (px) for adaptive thresholding. Roughly 2–3× the stroke width. Too small hollows out thick strokes; too large behaves like a global threshold.',
  },
  {
    key: 'binK', label: 'Sauvola k', stage: 7,
    min: 0.05, max: 0.8, step: 0.01, def: 0.25,
    description: 'Threshold aggressiveness. Higher = cleaner background but thinner/broken strokes; lower = fuller strokes but more background noise.',
  },
  {
    key: 'speckleMin', label: 'Min blob area', stage: 8,
    min: 0, max: 100, step: 1, def: 6,
    description: 'Ink blobs with fewer pixels than this are removed as noise. 0 disables. Keep below the area of dots on i/j and periods.',
  },
  {
    key: 'borderMargin', label: 'Border margin', stage: 8,
    min: 0, max: 40, step: 1, def: 10,
    description: 'Ink components lying ENTIRELY within this many px of an image edge are removed (page-edge shadows). Components extending into the interior are never touched. 0 disables.',
  },
  {
    key: 'pageManual', label: 'Manual page corners', stage: 2,
    min: 0, max: 1, step: 1, def: 0,
    description: 'Skip auto page detection and trust the quad already written via hw_quad() (set by the caller, not this slider).',
  },
  {
    key: 'pageInset', label: 'Page inset', stage: 3,
    min: 0, max: 3, step: 0.1, def: 0.4,
    description: 'Shrink the detected paper quad toward its centre by this percentage of the page before warping. The corners sit ON the paper edge, so sampling exactly there pulls the desk in along the rim; a small inset keeps every sample strictly inside the paper. Raise it if a dark border survives, lower it if writing near the edge is being clipped.',
  },
  {
    key: 'pageEdgeCover', label: 'Border overflow', stage: 2,
    min: 0.5, max: 1, step: 0.05, def: 0.85,
    description: 'How much of one image border the paper may cover before that border counts as "the sheet runs off the picture here". Three such borders — or an opposite pair — means no page rectangle is in frame and detection is declined, which is what stops a close-up photo being warped into a keystone. Raise it toward 1 if a page that genuinely fills the frame is being declined; lower it if a close-up is still being cropped.',
  },
];

export function defaultParams() {
  return Float32Array.from(PARAMS.map((p) => p.def));
}
