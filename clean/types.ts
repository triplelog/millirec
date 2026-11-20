// The data contracts that cross pass boundaries.
//
// rules.json  — full per-column rule traces in the flat/warped page coordinate
//               space, produced by Pass A.
// boxes.json  — word boxes in the coordinate space of the image the segmenter
//               ran on (Pass A's stage-4 "Illumination flatten" output, the
//               same space as the rules).

export interface RuleTrace {
  thickness: number;
  y: number[]; // y per column, length = page width
}

export interface VRuleTrace {
  thickness: number;
  x: number[]; // x per row, length = page height
}

export interface RulesJson {
  width: number;
  height: number;
  lineHeight: number; // auto-estimated by better; 0 if manual spacing was used
  rules: RuleTrace[];
  vrules?: VRuleTrace[];
}

export interface WordBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  confidence?: number;
  /** The gap to the NEXT word on this line is close to the split threshold, so the two
   *  words might really be one. Set by `ccWordBoxes`; the OCR step tries both groupings
   *  (reads the pair composited into one crop and merges if that reading wins). */
  mergeNext?: boolean;
}

export interface BoxesJson {
  width: number;
  height: number;
  lines: { words: WordBox[] }[];
}

/**
 * A formatting symbol written in the page's left margin, resolved to the line
 * it applies to. The pipeline recognizes these; what they MEAN is the caller's
 * business — an editor might turn 'heading' into an <h2>, a plain-text consumer
 * might prefix '##'.
 *
 * `line` indexes the pipeline's own line numbering (WordRec.line).
 */
export type MarginKind = 'heading' | 'bullet' | 'ordered' | 'blockquote' | 'linebreak';

export interface MarginMark {
  line: number;
  kind: MarginKind;
  /** Heading level = the number of '#' glyphs. Only set when kind is 'heading'. */
  level?: number;
}
