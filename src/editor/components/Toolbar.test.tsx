import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HistorySnapshot } from "../../core/history/commandHistory";
import type { EditorState } from "../state/editorReducer";
import { Toolbar, type ToolbarActions } from "./Toolbar";

const emptyState: EditorState = {
  status: "empty",
  session: null,
  selection: null,
  error: null,
};

const readyState: EditorState = {
  status: "ready",
  session: {
    token: "session-1",
    fingerprint: "fingerprint",
    baselineIdCounts: {},
    fileName: "deck.html",
    sourceHtml: "<html></html>",
    workingHtml: "<html></html>",
    srcDoc: "<html></html>",
    recoverySrcDoc: "<html></html>",
    overrides: {},
    previewUrl: "blob:preview",
    activeSlide: 1,
    slideCount: 2,
    stageSize: { width: 1920, height: 1080 },
    dirty: false,
  },
  selection: null,
  error: null,
};

const history = (
  overrides: Partial<HistorySnapshot> = {},
): HistorySnapshot => ({
  commands: [],
  canUndo: false,
  canRedo: false,
  size: 0,
  cursor: 0,
  ...overrides,
});

const actions = (): ToolbarActions => ({
  requestOpen: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  exportDeck: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
});

const zoomProps = {
  zoom: 100,
  minZoom: 25,
  maxZoom: 200,
};

describe("Toolbar", () => {
  it("disables deck commands before a deck is loaded", () => {
    render(
      <Toolbar
        state={emptyState}
        history={history()}
        actions={actions()}
        {...zoomProps}
      />,
    );

    expect(
      screen.getByRole("button", { name: "실행 취소" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "다시 실행" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "확대" }),
    ).toBeDisabled();
  });

  it("opens the existing hidden file input action", async () => {
    const user = userEvent.setup();
    const toolbarActions = actions();
    render(
      <Toolbar
        state={emptyState}
        history={history()}
        actions={toolbarActions}
        {...zoomProps}
      />,
    );

    await user.click(screen.getByRole("button", { name: "HTML 열기" }));

    expect(toolbarActions.requestOpen).toHaveBeenCalledOnce();
  });

  it("reflects history and exporting state without invoking disabled actions", async () => {
    const user = userEvent.setup();
    const toolbarActions = actions();
    const { rerender } = render(
      <Toolbar
        state={readyState}
        history={history({ canUndo: true })}
        actions={toolbarActions}
        {...zoomProps}
      />,
    );

    await user.click(screen.getByRole("button", { name: "실행 취소" }));
    await user.click(screen.getByRole("button", { name: "HTML 내보내기" }));

    expect(toolbarActions.undo).toHaveBeenCalledOnce();
    expect(toolbarActions.exportDeck).toHaveBeenCalledOnce();

    rerender(
      <Toolbar
        state={{ ...readyState, status: "exporting" }}
        history={history({ canUndo: true, canRedo: true })}
        actions={toolbarActions}
        {...zoomProps}
      />,
    );

    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toHaveTextContent("검증 중");
  });

  it("keeps export disabled until the bridge-free preview is synchronized", () => {
    render(
      <Toolbar
        state={{
          ...readyState,
          session: {
            ...readyState.session!,
            previewUrl: null,
          },
        }}
        history={history()}
        actions={actions()}
        {...zoomProps}
      />,
    );

    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toBeDisabled();
  });

  it("keeps familiar command buttons icon-only with accessible tooltips", () => {
    render(
      <Toolbar
        state={readyState}
        history={history()}
        actions={actions()}
        {...zoomProps}
      />,
    );

    const open = screen.getByRole("button", { name: "HTML 열기" });
    expect(open).toHaveAttribute("title", "HTML 열기");
    expect(open).toHaveTextContent("");
    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toHaveTextContent("HTML 내보내기");
  });

  it.each([
    {
      zoom: 25,
      disabledName: "축소",
      enabledName: "확대",
    },
    {
      zoom: 200,
      disabledName: "확대",
      enabledName: "축소",
    },
  ])(
    "disables $disabledName at the $zoom percent zoom boundary",
    ({ zoom, disabledName, enabledName }) => {
      render(
        <Toolbar
          state={readyState}
          history={history()}
          actions={actions()}
          zoom={zoom}
          minZoom={25}
          maxZoom={200}
        />,
      );

      expect(
        screen.getByRole("button", { name: disabledName }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: enabledName }),
      ).toBeEnabled();
    },
  );
});
