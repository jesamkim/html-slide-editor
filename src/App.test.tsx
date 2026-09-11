import { createRef, StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecoveryRecord } from "./core/persistence/sessionStore";
import type { DeckSessionController } from "./editor/hooks/useDeckSession";
import { initialEditorState } from "./editor/state/editorReducer";
import {
  INVALID_MISSING_STAGE,
  VALID_MINIMAL_DECK,
} from "./test/minimalDeck";
import App from "./App";

const htmlFile = (
  name: string,
  html: string,
  read: () => Promise<string> = async () => html,
) => {
  const file = new File([html], name, { type: "text/html" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: read,
  });
  return file;
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const recovery = (): RecoveryRecord => ({
  id: "recovery-1",
  fileName: "saved-deck.html",
  fingerprint: "saved-fingerprint",
  baselineIdCounts: { intro: 1 },
  html: VALID_MINIMAL_DECK,
  activeSlide: 1,
  overrides: {},
  commands: [],
  historyCursor: 0,
  exportedAt: null,
  updatedAt: Date.UTC(2026, 8, 2, 3, 4, 5),
});

const readyController = (
  overrides: Partial<DeckSessionController> = {},
): DeckSessionController => ({
  state: {
    status: "ready",
    error: null,
    selection: null,
    session: {
      token: "session-1",
      fingerprint: "current-fingerprint",
      baselineIdCounts: { intro: 1 },
      fileName: "quarterly.review.htm",
      sourceHtml: VALID_MINIMAL_DECK,
      workingHtml: VALID_MINIMAL_DECK,
      srcDoc: VALID_MINIMAL_DECK,
      recoverySrcDoc: VALID_MINIMAL_DECK,
      overrides: {},
      previewUrl: "blob:preview",
      activeSlide: 1,
      slideCount: 2,
      stageSize: { width: 1920, height: 1080 },
      dirty: true,
    },
  },
  history: {
    commands: [],
    canUndo: false,
    canRedo: false,
    size: 0,
    cursor: 0,
  },
  recovery: null,
  recoveryError: null,
  recoveryBusy: false,
  frameRef: createRef(),
  openFile: vi.fn(),
  handleFrameMessage: vi.fn(),
  sendCommand: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  selectSlide: vi.fn(),
  exportDeck: vi.fn(),
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn(),
  markRecoveryExported: vi.fn(),
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App", () => {
  it("opens directly into the editor workspace", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "HTML 열기" })).toBeVisible();
    expect(screen.getByRole("note")).toHaveTextContent(
      "신뢰하는 로컬 HTML 파일만 여세요",
    );
    expect(screen.getByLabelText("슬라이드 목록")).toBeVisible();
    expect(screen.getByLabelText("슬라이드 캔버스")).toBeVisible();
    expect(screen.getByLabelText("속성 패널")).toBeVisible();
    expect(screen.getByLabelText("편집기 상태")).toBeVisible();
    expect(document.querySelector(".editor-app")).toHaveClass(
      "editor-app--powerpoint",
    );
  });

  it("keeps unsupported mutations disabled while Task 9 cannot acknowledge them", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("deck.html", VALID_MINIMAL_DECK),
    );
    await screen.findByTitle("편집 중인 슬라이드");

    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "슬라이드 1 이동" }),
    ).toBeDisabled();
    for (const button of screen.getAllByRole("button", {
      name: "선택 항목 복제",
    })) {
      expect(button).toBeDisabled();
    }
  });

  it("stops zoom commands at the configured 25 and 200 percent limits", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("deck.html", VALID_MINIMAL_DECK),
    );
    await screen.findByTitle("편집 중인 슬라이드");

    const zoomIn = screen.getByRole("button", { name: "확대" });
    for (let index = 0; index < 10; index += 1) {
      await user.click(zoomIn);
    }
    expect(screen.getByText("200%")).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();

    const zoomOut = screen.getByRole("button", { name: "축소" });
    for (let index = 0; index < 18; index += 1) {
      await user.click(zoomOut);
    }
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(zoomOut).toBeDisabled();
  });

  it("completes import under the StrictMode composition used by main", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("deck.html", VALID_MINIMAL_DECK),
    );

    expect(
      await screen.findByTitle("편집 중인 슬라이드"),
    ).toHaveAttribute("sandbox", "allow-scripts");
  });

  it("announces loading while an import is pending", async () => {
    const user = userEvent.setup();
    const read = deferred<string>();
    render(<App />);

    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("pending.html", VALID_MINIMAL_DECK, () => read.promise),
    );

    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");

    read.resolve(VALID_MINIMAL_DECK);
    expect(
      await screen.findByTitle("편집 중인 슬라이드"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("announces the first invalid import without mounting a frame", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("invalid.html", INVALID_MISSING_STAGE),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("#stage");
    expect(
      screen.queryByTitle("편집 중인 슬라이드"),
    ).not.toBeInTheDocument();
  });

  it("preserves the current frame and announces a failed replacement", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("good.html", VALID_MINIMAL_DECK),
    );
    const currentFrame = await screen.findByTitle("편집 중인 슬라이드");

    await user.upload(
      screen.getByLabelText("HTML 파일 선택"),
      htmlFile("invalid.html", INVALID_MISSING_STAGE),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("#stage");
    expect(screen.getByTitle("편집 중인 슬라이드")).toBe(currentFrame);
  });

  it("downloads the verified HTML with an edited suffix before marking recovery exported", async () => {
    const user = userEvent.setup();
    const exportDeck = vi.fn().mockResolvedValue({
      html: "<!DOCTYPE html><html><body>verified</body></html>",
      fileName: "quarterly.review.htm",
      validation: { ok: true },
    });
    const markRecoveryExported = vi.fn().mockResolvedValue(true);
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:verified-export");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    let clickedAnchor: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function captureAnchor(
        this: HTMLAnchorElement,
      ) {
        clickedAnchor = this;
      });
    const controller = readyController({
      exportDeck,
      markRecoveryExported,
    });

    render(<App sessionHook={() => controller} />);
    await user.click(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    );

    await waitFor(() => {
      expect(markRecoveryExported).toHaveBeenCalledOnce();
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    await expect(blob.text()).resolves.toContain("verified");
    expect(clickedAnchor).toMatchObject({
      href: "blob:verified-export",
      download: "quarterly.review-edited.html",
    });
    expect(click.mock.invocationCallOrder[0]).toBeLessThan(
      markRecoveryExported.mock.invocationCallOrder[0],
    );
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:verified-export",
    );
    expect(clickedAnchor!.isConnected).toBe(false);
  });

  it("keeps the editor session and announces an exact export failure without a Blob download", async () => {
    const user = userEvent.setup();
    const exportDeck = vi
      .fn()
      .mockRejectedValue(
        new Error("슬라이드 런타임 검증 시간이 초과되었습니다."),
      );
    const markRecoveryExported = vi.fn();
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const controller = readyController({
      exportDeck,
      markRecoveryExported,
    });

    render(<App sessionHook={() => controller} />);
    await user.click(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "슬라이드 런타임 검증 시간이 초과되었습니다.",
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(markRecoveryExported).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toBeEnabled();
  });

  it("shows recovery details and wires only explicit restore or discard actions", async () => {
    const user = userEvent.setup();
    const restoreRecovery = vi.fn();
    const discardRecovery = vi.fn();
    const record = recovery();
    const controller = readyController({
      recovery: record,
      restoreRecovery,
      discardRecovery,
    });

    render(<App sessionHook={() => controller} />);

    expect(document.querySelector(".editor-app")).toHaveAttribute("inert");
    expect(document.querySelector(".editor-app")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      screen.getByRole("dialog", { name: "편집 세션 복구" }),
    ).toBeVisible();
    expect(screen.getByText(record.fileName)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "현재 열린 파일과 원본 지문이 다릅니다.",
    );
    expect(restoreRecovery).not.toHaveBeenCalled();
    expect(discardRecovery).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "세션 복구" }));
    await user.click(
      screen.getByRole("button", { name: "복구 기록 삭제" }),
    );

    expect(restoreRecovery).toHaveBeenCalledOnce();
    expect(discardRecovery).toHaveBeenCalledOnce();
  });

  it("can render an injected empty controller for deterministic recovery UX tests", () => {
    const controller = readyController({
      state: initialEditorState,
    });

    render(<App sessionHook={() => controller} />);

    expect(
      screen.getByRole("button", { name: "HTML 내보내기" }),
    ).toBeDisabled();
  });

  it("renders the current selection path as an accessible breadcrumb", () => {
    const controller = readyController({
      state: {
        ...readyController().state,
        selection: {
          targetId: "title-1",
          path: ["section#intro.slide", "div.hero", "h1.title"],
          bounds: { x: 100, y: 80, width: 500, height: 90 },
          kind: "text",
          text: "Title",
          styles: null,
        },
      },
    });

    render(<App sessionHook={() => controller} />);

    const breadcrumb = screen.getByRole("navigation", {
      name: "선택 경로",
    });
    expect(breadcrumb).toHaveTextContent("section#intro.slide");
    expect(breadcrumb).toHaveTextContent("div.hero");
    expect(breadcrumb).toHaveTextContent("h1.title");
    expect(
      screen.getByText("h1.title"),
    ).toHaveAttribute("aria-current", "page");
  });
});
