import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../../core/document/types";
import {
  editorReducer,
  initialEditorState,
  type EditorSession,
  type EditorState,
} from "./editorReducer";

const session = (
  overrides: Partial<EditorSession> = {},
): EditorSession => ({
  token: "session-current",
  fingerprint: "fingerprint-current",
  baselineIdCounts: {},
  fileName: "good.html",
  sourceHtml: "<!doctype html><html></html>",
  workingHtml: "<!doctype html><html></html>",
  srcDoc: "<!doctype html><html></html>",
  recoverySrcDoc: "<!doctype html><html></html>",
  overrides: {},
  previewUrl: "blob:current",
  activeSlide: 1,
  slideCount: 2,
  stageSize: { width: 1920, height: 1080 },
  dirty: false,
  ...overrides,
});

const readyState = (
  overrides: Partial<EditorState> = {},
): EditorState => ({
  ...initialEditorState,
  status: "ready",
  session: session(),
  ...overrides,
});

const selection: SelectionSnapshot = {
  targetId: "node-1",
  path: ["section.slide", "h1"],
  bounds: { x: 10, y: 20, width: 300, height: 80 },
  kind: "text",
  text: null,
  styles: null,
};

describe("editorReducer", () => {
  it("installs a validated session and clears prior transient state", () => {
    const imported = session({ token: "session-imported" });
    const next = editorReducer(
      {
        ...initialEditorState,
        status: "error",
        selection,
        error: "old error",
      },
      { type: "importSucceeded", session: imported },
    );

    expect(next).toEqual({
      status: "ready",
      session: imported,
      selection: null,
      error: null,
    });
  });

  it("keeps the current session when a replacement import fails", () => {
    const current = readyState();
    const loading = editorReducer(current, { type: "importStarted" });

    const failed = editorReducer(loading, {
      type: "importFailed",
      error: "#stage 요소가 없습니다.",
    });

    expect(failed.status).toBe("ready");
    expect(failed.session).toBe(current.session);
    expect(failed.session?.fileName).toBe("good.html");
    expect(failed.error).toContain("#stage");
  });

  it("enters an error state when the first import fails", () => {
    const failed = editorReducer(initialEditorState, {
      type: "importFailed",
      error: "편집할 슬라이드가 없습니다.",
    });

    expect(failed).toMatchObject({
      status: "error",
      session: null,
      error: "편집할 슬라이드가 없습니다.",
    });
  });

  it("ignores stale-token frame updates after a newer session is loaded", () => {
    const current = readyState({
      session: session({ token: "session-new", slideCount: 4 }),
    });

    const ready = editorReducer(current, {
      type: "frameReady",
      token: "session-old",
      slideCount: 99,
    });
    const synced = editorReducer(current, {
      type: "documentSynced",
      token: "session-old",
      html: "<html>stale</html>",
      recoverySrcDoc: "<html>stale recovery</html>",
      previewUrl: "blob:stale",
      dirty: true,
    });
    const selected = editorReducer(current, {
      type: "selectionChanged",
      token: "session-old",
      selection,
    });

    expect(ready).toBe(current);
    expect(synced).toBe(current);
    expect(selected).toBe(current);
  });

  it("applies matching-token document and selection updates", () => {
    const current = readyState();
    const ready = editorReducer(current, {
      type: "frameReady",
      token: "session-current",
      slideCount: 3,
    });
    const synced = editorReducer(ready, {
      type: "documentSynced",
      token: "session-current",
      html: "<!doctype html><html><body>updated</body></html>",
      recoverySrcDoc: "<!doctype html><html><body>recovery</body></html>",
      previewUrl: "blob:updated",
      dirty: true,
    });
    const selected = editorReducer(synced, {
      type: "selectionChanged",
      token: "session-current",
      selection,
    });

    expect(selected.session).toMatchObject({
      slideCount: 3,
      workingHtml: "<!doctype html><html><body>updated</body></html>",
      recoverySrcDoc: "<!doctype html><html><body>recovery</body></html>",
      previewUrl: "blob:updated",
      dirty: true,
    });
    expect(selected.selection).toEqual(selection);
  });

  it("applies acknowledged overrides, active slide, and selection atomically", () => {
    const nextSelection: SelectionSnapshot = {
      ...selection,
      targetId: "node-2",
      text: "Updated",
    };

    const next = editorReducer(readyState({ selection }), {
      type: "mutationAcknowledged",
      token: "session-current",
      html: "<!doctype html><html><body>checkpoint</body></html>",
      recoverySrcDoc:
        "<!doctype html><html><body>recovery checkpoint</body></html>",
      previewUrl: "blob:checkpoint",
      overrides: {
        "node-2": { translate: "20px 0px" },
      },
      slideCount: 3,
      activeSlideIndex: 1,
      selection: nextSelection,
    });

    expect(next.session).toMatchObject({
      overrides: {
        "node-2": { translate: "20px 0px" },
      },
      workingHtml: "<!doctype html><html><body>checkpoint</body></html>",
      recoverySrcDoc:
        "<!doctype html><html><body>recovery checkpoint</body></html>",
      previewUrl: "blob:checkpoint",
      slideCount: 3,
      activeSlide: 2,
      dirty: true,
    });
    expect(next.selection).toEqual(nextSelection);
  });

  it("clears object selection when the active slide changes", () => {
    const next = editorReducer(readyState({ selection }), {
      type: "activeSlideChanged",
      token: "session-current",
      activeSlide: 2,
    });

    expect(next.session?.activeSlide).toBe(2);
    expect(next.selection).toBeNull();
  });

  it("keeps a loaded session usable when export preparation fails", () => {
    const current = readyState();
    const exporting = editorReducer(current, {
      type: "exportStarted",
      token: "session-current",
    });
    const failed = editorReducer(exporting, {
      type: "exportFailed",
      token: "session-current",
      error: "내보낼 문서를 검증할 수 없습니다.",
    });

    expect(exporting.status).toBe("exporting");
    expect(failed).toMatchObject({
      status: "ready",
      session: current.session,
      error: "내보낼 문서를 검증할 수 없습니다.",
    });
  });
});
