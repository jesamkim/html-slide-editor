export interface StageSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds extends Point {
  width: number;
  height: number;
}

export type SelectionKind = "text" | "image" | "svg" | "container";

export interface SelectionSnapshot {
  targetId: string;
  path: string[];
  bounds: Bounds;
  kind: SelectionKind;
  transform?: {
    translateX: number;
    translateY: number;
  };
  snapTargets?: Array<{
    axis: "x" | "y";
    value: number;
    kind: string;
  }>;
  text: string | null;
  styles: {
    fontSize: string;
    color: string;
    fontWeight: string;
    textAlign: "left" | "center" | "right";
  } | null;
}

export interface ElementPatch {
  translateX?: number;
  translateY?: number;
  width?: number;
  height?: number | "auto";
  text?: string;
  fontSize?: string;
  color?: string;
  fontWeight?: string;
  textAlign?: "left" | "center" | "right";
}

export type ElementOverrideTable = Record<string, Record<string, string>>;

export interface SlideMetadata {
  id: string;
  index: number;
  sourceId: string | null;
  label: string;
}

export interface DeckMetadata {
  fileName: string;
  title: string;
  slideCount: number;
  stageSize: StageSize;
  slides: SlideMetadata[];
}

export type DeckParseError = {
  ok: false;
  code: "INVALID_HTML" | "MISSING_STAGE" | "NO_SLIDES";
  message: string;
};

export type DeckParseResult =
  | { ok: true; metadata: DeckMetadata; document: Document }
  | DeckParseError;
