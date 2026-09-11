import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import referenceDeck from "../../../tests/fixtures/reference-deck.html?raw";
import App from "../../App";
import type { DeckSessionController } from "../../editor/hooks/useDeckSession";
import { VALID_MINIMAL_DECK } from "../../test/minimalDeck";
import { validateExportInFrame } from "./validateExport";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
) => {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Browser condition timed out");
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
};

const controller = (
  exportDeck: DeckSessionController["exportDeck"],
  markRecoveryExported: DeckSessionController["markRecoveryExported"],
): DeckSessionController => ({
  state: {
    status: "ready",
    error: null,
    selection: null,
    session: {
      token: "browser-session",
      fingerprint: "browser-fingerprint",
      baselineIdCounts: {},
      fileName: "reference.html",
      sourceHtml: referenceDeck,
      workingHtml: referenceDeck,
      srcDoc: referenceDeck,
      recoverySrcDoc: referenceDeck,
      overrides: {},
      previewUrl: "blob:preview",
      activeSlide: 1,
      slideCount: 22,
      stageSize: { width: 1920, height: 1080 },
      dirty: false,
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
  exportDeck,
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn(),
  markRecoveryExported,
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  document
    .querySelectorAll('iframe[title="내보내기 검증"]')
    .forEach((iframe) => iframe.remove());
});

test("validates, navigates, downloads, and cleans the exact 22-slide deck", async () => {
  const parsed = new DOMParser().parseFromString(referenceDeck, "text/html");
  expect(parsed.querySelectorAll("#stage > .slide")).toHaveLength(22);
  expect(typeof document.startViewTransition).toBe("function");
  const runtimeStates: unknown[] = [];
  const captureRuntimeState = (event: MessageEvent) => {
    if (event.data?.type === "slidecast-state") {
      runtimeStates.push(event.data);
    }
  };
  window.addEventListener("message", captureRuntimeState);

  const validation = validateExportInFrame(referenceDeck, {
    timeoutMs: 5_000,
  });
  const validationFrame = document.querySelector<HTMLIFrameElement>(
    'iframe[title="내보내기 검증"]',
  )!;
  const computed = getComputedStyle(validationFrame);

  expect(validationFrame.hidden).toBe(false);
  expect(computed.position).toBe("fixed");
  expect(computed.width).toBe("1px");
  expect(computed.height).toBe("1px");
  expect(computed.opacity).toBe("0");
  expect(computed.pointerEvents).toBe("none");
  const validationBounds = validationFrame.getBoundingClientRect();
  expect(validationBounds.width).toBe(1);

  const validationResult = await validation;
  window.removeEventListener("message", captureRuntimeState);
  if (!validationResult.ok) {
    throw new Error(
      `${validationResult.code}: ${JSON.stringify(runtimeStates)}`,
    );
  }
  expect(validationResult).toEqual({ ok: true });
  expect(validationFrame.isConnected).toBe(false);

  const markRecoveryExported = vi.fn().mockResolvedValue(true);
  const clicked: HTMLAnchorElement[] = [];
  const preventDownload = (event: MouseEvent) => {
    const anchor = event.target;
    if (anchor instanceof HTMLAnchorElement && anchor.download) {
      event.preventDefault();
      clicked.push(anchor);
    }
  };
  document.addEventListener("click", preventDownload, true);
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <App
      sessionHook={() =>
        controller(
          async () => ({
            html: referenceDeck,
            fileName: "reference.html",
            validation: { ok: true },
          }),
          markRecoveryExported,
        )
      }
    />,
  );
  await waitFor(
    () =>
      host?.querySelector<HTMLButtonElement>(
        'button[aria-label="HTML 내보내기"]',
      ) !== null,
  );
  host!
    .querySelector<HTMLButtonElement>(
      'button[aria-label="HTML 내보내기"]',
    )!
    .click();
  await waitFor(() => markRecoveryExported.mock.calls.length === 1);
  document.removeEventListener("click", preventDownload, true);

  expect(clicked).toHaveLength(1);
  expect(clicked[0].download).toBe("reference-edited.html");
  expect(clicked[0].isConnected).toBe(false);
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});

test("ignores a stale source, times out, and cleans real browser resources", async () => {
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  const validation = validateExportInFrame(VALID_MINIMAL_DECK, {
    timeoutMs: 50,
  });
  const validationFrame = document.querySelector<HTMLIFrameElement>(
    'iframe[title="내보내기 검증"]',
  )!;

  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { type: "slidecast-state", cur: 1, total: 2 },
    }),
  );

  await expect(validation).resolves.toMatchObject({
    ok: false,
    code: "RUNTIME_TIMEOUT",
  });
  expect(validationFrame.isConnected).toBe(false);
  expect(
    document.querySelector('iframe[title="내보내기 검증"]'),
  ).toBeNull();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});

test.each([
  [
    "uncaught error",
    `<script>addEventListener("load", () => { throw new Error("browser boom"); });</script>`,
  ],
  [
    "unhandled rejection",
    `<script>addEventListener("load", () => { Promise.reject(new Error("browser rejection")); });</script>`,
  ],
])("fails export validation on %s", async (_label, script) => {
  const html = VALID_MINIMAL_DECK.replace("</head>", `${script}</head>`);

  await expect(
    validateExportInFrame(html, { timeoutMs: 2_000 }),
  ).resolves.toMatchObject({
    ok: false,
    code: "RUNTIME_ERROR",
  });
});

test("fails when navigation publishes the expected state and then throws", async () => {
  const html = VALID_MINIMAL_DECK.replace(
    "</body>",
    `<script>
      parent.postMessage(
        { type: "slidecast-state", cur: 1, total: 2 },
        "*",
      );
      addEventListener("message", (event) => {
        if (
          event.data?.type === "slidecast-nav" &&
          event.data.action === "next"
        ) {
          parent.postMessage(
            { type: "slidecast-state", cur: 2, total: 2 },
            "*",
          );
          throw new Error("navigation failed after state");
        }
      });
    </script></body>`,
  );

  await expect(
    validateExportInFrame(html, { timeoutMs: 2_000 }),
  ).resolves.toMatchObject({
    ok: false,
    code: "RUNTIME_ERROR",
    message: expect.stringContaining("navigation failed after state"),
  });
});

test("accepts navigation when an optional view transition is skipped", async () => {
  const html = VALID_MINIMAL_DECK.replace(
    "</body>",
    `<script>
      let current = 1;
      const publish = () => parent.postMessage(
        { type: "slidecast-state", cur: current, total: 2 },
        "*",
      );
      const show = (next) => {
        document.startViewTransition(() => {
          current = next;
          publish();
        });
      };
      addEventListener("message", (event) => {
        if (
          event.data?.type === "slidecast-nav" &&
          event.data.action === "next"
        ) {
          show(2);
        }
      });
      show(1);
    </script></body>`,
  );

  await expect(
    validateExportInFrame(html, { timeoutMs: 2_000 }),
  ).resolves.toEqual({ ok: true });
});
