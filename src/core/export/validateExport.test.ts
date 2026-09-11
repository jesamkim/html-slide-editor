import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VALID_MINIMAL_DECK } from "../../test/minimalDeck";
import {
  validateExportInFrame,
  validateExportStructure,
} from "./validateExport";

const runtimeDeck = VALID_MINIMAL_DECK.replace(
  "</body>",
  `<script>
    (() => {
      let cur = 1;
      const total = 2;
      const publish = () => parent.postMessage(
        { type: "slidecast-state", cur, total },
        "*",
      );
      addEventListener("message", (event) => {
        if (event.data?.type !== "slidecast-nav") return;
        if (event.data.action === "next") cur += 1;
        publish();
      });
      publish();
    })();
  </script></body>`,
);

const dispatchFrameState = (
  source: MessageEventSource,
  data: unknown,
) => {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", {
    configurable: true,
    value: source,
  });
  window.dispatchEvent(event);
};

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export-validation");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document
    .querySelectorAll('iframe[title="내보내기 검증"]')
    .forEach((iframe) => iframe.remove());
});

describe("validateExportStructure", () => {
  it("accepts a complete bridge-free deck with the expected slides", () => {
    expect(validateExportStructure(VALID_MINIMAL_DECK, 2, { intro: 1 })).toEqual({
      ok: true,
    });
  });

  it("rejects a missing doctype before runtime validation", () => {
    expect(
      validateExportStructure(
        VALID_MINIMAL_DECK.replace("<!doctype html>", ""),
        2,
        { intro: 1 },
      ),
    ).toEqual({
      ok: false,
      code: "INVALID_HTML",
      message: "내보내기 HTML에 doctype이 없습니다.",
    });
  });

  it("rejects a missing stage before runtime validation", () => {
    expect(
      validateExportStructure(
        VALID_MINIMAL_DECK.replace('id="stage"', 'id="content"'),
        2,
        { intro: 1 },
      ),
    ).toEqual({
      ok: false,
      code: "INVALID_HTML",
      message: "내보내기 HTML에 #stage 요소가 없습니다.",
    });
  });

  it("rejects a changed direct slide count", () => {
    expect(validateExportStructure(VALID_MINIMAL_DECK, 3, { intro: 1 })).toEqual({
      ok: false,
      code: "SLIDE_COUNT",
      message: "슬라이드 수가 일치하지 않습니다. 예상 3개, 실제 2개입니다.",
    });
  });

  it("rejects bridge and editor artifacts", () => {
    const htmlWithBridge = VALID_MINIMAL_DECK.replace(
      "</body>",
      '<script data-hse-editor-bridge></script></body>',
    );

    expect(
      validateExportStructure(htmlWithBridge, 2, { intro: 1 }),
    ).toMatchObject({
      ok: false,
      code: "EDITOR_ARTIFACT",
      message: "편집기 브리지 마커가 남아 있습니다.",
    });
  });

  it.each([
    [
      "template content",
      "<template><script data-hse-editor-bridge></script></template>",
    ],
    [
      "iframe srcdoc",
      '<iframe srcdoc="&lt;aside data-hse-editor-artifact&gt;&lt;/aside&gt;"></iframe>',
    ],
  ])("rejects editor artifacts nested in %s", (_name, artifact) => {
    const nested = VALID_MINIMAL_DECK.replace(
      "</body>",
      `${artifact}</body>`,
    );

    expect(
      validateExportStructure(nested, 2, { intro: 1 }),
    ).toMatchObject({
      ok: false,
      code: "EDITOR_ARTIFACT",
    });
  });

  it("keeps R8 baseline duplicate IDs but rejects increased counts", () => {
    const duplicated = VALID_MINIMAL_DECK.replace(
      "</main>",
      '<div id="intro"></div></main>',
    );

    expect(
      validateExportStructure(duplicated, 2, { intro: 1 }),
    ).toEqual({
      ok: false,
      code: "EDITOR_ARTIFACT",
      message: "중복 HTML id가 증가했습니다: intro (1 -> 2)",
    });
    expect(
      validateExportStructure(duplicated, 2, { intro: 2 }),
    ).toEqual({ ok: true });
  });
});

describe("validateExportInFrame", () => {
  it.each([
    ["before navigation", "initial"],
    ["during navigation", "next"],
  ])("fails on an uncaught runtime error %s", async (_label, phase) => {
    const validation = validateExportInFrame(runtimeDeck, {
      timeoutMs: 1_000,
      validationToken: "validation-1",
    });
    const frameWindow = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!.contentWindow!;

    if (phase === "next") {
      dispatchFrameState(frameWindow, {
        type: "slidecast-state",
        cur: 1,
        total: 2,
      });
    }
    dispatchFrameState(frameWindow, {
      type: "hse:export-runtime-error",
      validationToken: "validation-1",
      kind: "error",
      message: "boom",
    });

    await expect(validation).resolves.toEqual({
      ok: false,
      code: "RUNTIME_ERROR",
      message: "내보내기 런타임 오류: boom",
    });
  });

  it("accepts the initial runtime state when one slide remains", async () => {
    vi.useFakeTimers();
    const parsed = new DOMParser().parseFromString(
      VALID_MINIMAL_DECK,
      "text/html",
    );
    parsed.querySelectorAll("#stage > .slide")[1]?.remove();
    const oneSlideDeck =
      `<!doctype html>\n${parsed.documentElement.outerHTML}`;
    const validation = validateExportInFrame(oneSlideDeck, {
      timeoutMs: 250,
    });
    const frameWindow = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!.contentWindow!;
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    dispatchFrameState(frameWindow, {
      type: "slidecast-state",
      cur: 1,
      total: 1,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(validation).resolves.toEqual({ ok: true });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("advances through first-slide reveals without requiring reveal broadcasts", async () => {
    vi.useFakeTimers();
    const revealDeck = runtimeDeck.replace(
      "<h1>Introduction</h1>",
      "<h1>Introduction</h1><i data-step></i><i data-step></i>",
    );
    const validation = validateExportInFrame(revealDeck, {
      timeoutMs: 1_000,
    });
    const frameWindow = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!.contentWindow!;
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    dispatchFrameState(frameWindow, {
      type: "slidecast-state",
      cur: 1,
      total: 2,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(postMessage).toHaveBeenCalledTimes(3);
    dispatchFrameState(frameWindow, {
      type: "slidecast-state",
      cur: 2,
      total: 2,
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(validation).resolves.toEqual({ ok: true });
  });

  it("requires initial state then verifies one next navigation", async () => {
    const validation = validateExportInFrame(runtimeDeck, {
      timeoutMs: 1_000,
    });
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!;
    const frameWindow = iframe.contentWindow!;
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    dispatchFrameState(
      frameWindow,
      { type: "slidecast-state", cur: 1, total: 2 },
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: "slidecast-nav",
      action: "next",
    }, "*");

    dispatchFrameState(
      frameWindow,
      { type: "slidecast-state", cur: 2, total: 2 },
    );

    await expect(validation).resolves.toEqual({ ok: true });
    expect(iframe.isConnected).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:export-validation",
    );
  });

  it("ignores stale messages from any source except the exact iframe window", async () => {
    const validation = validateExportInFrame(runtimeDeck, {
      timeoutMs: 1_000,
    });
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!;
    const frameWindow = iframe.contentWindow!;
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    dispatchFrameState(
      window,
      { type: "slidecast-state", cur: 1, total: 2 },
    );
    expect(postMessage).not.toHaveBeenCalled();

    dispatchFrameState(
      frameWindow,
      { type: "slidecast-state", cur: 1, total: 2 },
    );
    dispatchFrameState(
      frameWindow,
      { type: "slidecast-state", cur: 2, total: 2 },
    );

    await expect(validation).resolves.toEqual({ ok: true });
  });

  it("reports invalid initial runtime state as navigation failure", async () => {
    const validation = validateExportInFrame(runtimeDeck, {
      timeoutMs: 1_000,
    });
    const frameWindow = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!.contentWindow!;

    dispatchFrameState(
      frameWindow,
      { type: "slidecast-state", cur: 2, total: 2 },
    );

    await expect(validation).resolves.toEqual({
      ok: false,
      code: "NAVIGATION",
      message: "슬라이드 런타임의 초기 상태가 올바르지 않습니다.",
    });
  });

  it("times out and cleans every temporary runtime resource", async () => {
    vi.useFakeTimers();
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    const validation = validateExportInFrame(runtimeDeck, {
      timeoutMs: 250,
    });
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="내보내기 검증"]',
    )!;

    await vi.advanceTimersByTimeAsync(250);

    await expect(validation).resolves.toEqual({
      ok: false,
      code: "RUNTIME_TIMEOUT",
      message: "슬라이드 런타임 검증 시간이 초과되었습니다.",
    });
    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
    expect(iframe.isConnected).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:export-validation",
    );
  });
});
