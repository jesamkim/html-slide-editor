import type {
  ElementOverrideTable,
  SelectionSnapshot,
  StageSize,
} from "../../core/document/types";
import type { HtmlIdCounts } from "../../core/export/exportDocument";

export type EditorStatus =
  | "empty"
  | "loading"
  | "ready"
  | "exporting"
  | "error";

export interface EditorSession {
  token: string;
  fingerprint: string;
  baselineIdCounts: HtmlIdCounts;
  fileName: string;
  sourceHtml: string;
  workingHtml: string;
  srcDoc: string;
  recoverySrcDoc: string;
  overrides: ElementOverrideTable;
  previewUrl: string | null;
  activeSlide: number;
  slideCount: number;
  stageSize: StageSize;
  dirty: boolean;
}

export interface EditorState {
  status: EditorStatus;
  session: EditorSession | null;
  selection: SelectionSnapshot | null;
  error: string | null;
}

export const initialEditorState: EditorState = {
  status: "empty",
  session: null,
  selection: null,
  error: null,
};

export type EditorAction =
  | { type: "importStarted" }
  | { type: "importSucceeded"; session: EditorSession }
  | { type: "importFailed"; error: string }
  | { type: "frameReady"; token: string; slideCount: number }
  | {
      type: "documentSynced";
      token: string;
      html: string;
      recoverySrcDoc: string;
      previewUrl: string;
      dirty: boolean;
    }
  | {
      type: "selectionChanged";
      token: string;
      selection: SelectionSnapshot | null;
    }
  | {
      type: "mutationAcknowledged";
      token: string;
      html: string;
      recoverySrcDoc: string;
      previewUrl: string;
      overrides: ElementOverrideTable;
      slideCount: number;
      activeSlideIndex: number;
      selection: SelectionSnapshot | null;
    }
  | {
      type: "activeSlideChanged";
      token: string;
      activeSlide: number;
    }
  | { type: "exportStarted"; token: string }
  | { type: "exportSucceeded"; token: string }
  | { type: "exportFailed"; token: string; error: string }
  | { type: "sessionFailed"; token: string; error: string };

const hasCurrentToken = (state: EditorState, token: string) =>
  state.session?.token === token;

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.type) {
    case "importStarted":
      return { ...state, status: "loading", error: null };

    case "importSucceeded":
      return {
        status: "ready",
        session: action.session,
        selection: null,
        error: null,
      };

    case "importFailed":
      return {
        ...state,
        status: state.session ? "ready" : "error",
        error: action.error,
      };

    case "frameReady":
      if (!hasCurrentToken(state, action.token)) return state;
      return {
        ...state,
        session: {
          ...state.session!,
          slideCount: action.slideCount,
        },
      };

    case "documentSynced":
      if (!hasCurrentToken(state, action.token)) return state;
      return {
        ...state,
        session: {
          ...state.session!,
          workingHtml: action.html,
          recoverySrcDoc: action.recoverySrcDoc,
          previewUrl: action.previewUrl,
          dirty: action.dirty,
        },
        error: null,
      };

    case "selectionChanged":
      if (!hasCurrentToken(state, action.token)) return state;
      return { ...state, selection: action.selection };

    case "mutationAcknowledged":
      if (!hasCurrentToken(state, action.token)) return state;
      return {
        ...state,
        session: {
          ...state.session!,
          workingHtml: action.html,
          recoverySrcDoc: action.recoverySrcDoc,
          previewUrl: action.previewUrl,
          overrides: action.overrides,
          slideCount: action.slideCount,
          activeSlide: action.activeSlideIndex + 1,
          dirty: true,
        },
        selection: action.selection,
        error: null,
      };

    case "activeSlideChanged":
      if (!hasCurrentToken(state, action.token)) return state;
      return {
        ...state,
        session: {
          ...state.session!,
          activeSlide: action.activeSlide,
        },
        selection: null,
      };

    case "exportStarted":
      if (!hasCurrentToken(state, action.token)) return state;
      return { ...state, status: "exporting", error: null };

    case "exportSucceeded":
      if (!hasCurrentToken(state, action.token)) return state;
      return { ...state, status: "ready", error: null };

    case "exportFailed":
    case "sessionFailed":
      if (!hasCurrentToken(state, action.token)) return state;
      return { ...state, status: "ready", error: action.error };
  }
}
