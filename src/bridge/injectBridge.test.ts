// @ts-expect-error jsdom has no declaration package in this project.
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import referenceDeck from "../../tests/fixtures/reference-deck.html?raw";
import { prepareExport } from "../core/export/exportDocument";
import { INVALID_MISSING_STAGE, VALID_MINIMAL_DECK } from "../test/minimalDeck";
import { declareInjectedHelpers, injectBridge } from "./injectBridge";

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  top: y,
  right: x + width,
  bottom: y + height,
  left: x,
  toJSON: () => ({}),
});

const waitForLoad = async (dom: InstanceType<typeof JSDOM>) => {
  if (dom.window.document.readyState === "complete") return;
  await new Promise<void>((resolve) => {
    dom.window.addEventListener("load", () => resolve(), { once: true });
  });
};

const domEventFactory =
  (type: "error" | "unhandledrejection", message: string) =>
  (targetWindow: InstanceType<typeof JSDOM>["window"]) => {
    const event = new targetWindow.Event(type);
    if (type === "error") {
      Object.defineProperty(event, "message", { value: message });
    } else {
      Object.defineProperty(event, "reason", {
        value: new Error(message),
      });
    }
    return event;
  };

const deckWithOriginalCaptureHandlers = () =>
  VALID_MINIMAL_DECK.replace(
    "</head>",
    `<script>
      window.deckClickCount = 0;
      window.deckDoubleClickCount = 0;
      window.deckKeyCount = 0;
      window.addEventListener("click", () => {
        window.deckClickCount += 1;
      }, true);
      window.addEventListener("dblclick", () => {
        window.deckDoubleClickCount += 1;
      }, true);
      window.addEventListener("keydown", () => {
        window.deckKeyCount += 1;
      }, true);
    </script></head>`,
  );

describe("injectBridge", () => {
  it("caches a mutation ACK by request id and does not reapply a duplicate request", () => {
    const source = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Introduction</h1>',
    );
    const dom = new JSDOM(injectBridge(source, "session-1"), {
      runScripts: "outside-only",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    const request = {
      type: "hse:duplicate-object",
      token: "session-1",
      requestId: "duplicate-once",
      commandId: "duplicate-1",
      label: "Duplicate object",
      targetId: "node-1",
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: request,
        }),
      );
    }

    const acknowledgements = sent.filter(
      (message) =>
        message.type === "hse:mutation-ack" &&
        message.requestId === "duplicate-once",
    );
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements[1]).toEqual(acknowledgements[0]);
    const checkpoint = (
      acknowledgements[0].result as { checkpointHtml: string }
    ).checkpointHtml;
    expect(checkpoint).toContain("<!DOCTYPE html>");
    expect(checkpoint).not.toContain("data-hse-editor-bridge");
    expect(checkpoint).not.toContain("hse-live-overrides");
    expect(checkpoint).toContain("Introduction");
    expect(
      dom.window.document.querySelectorAll("#stage > .slide h1"),
    ).toHaveLength(2);
  });

  it("creates a bridge-free cached mutation checkpoint for the large reference deck", () => {
    const dom = new JSDOM(injectBridge(referenceDeck, "session-1"), {
      runScripts: "outside-only",
      url: "https://deck.test/",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    sent.length = 0;
    const request = {
      type: "hse:duplicate-slide",
      token: "session-1",
      requestId: "reference-duplicate",
      commandId: "reference-duplicate",
      label: "Duplicate reference slide",
      slideIndex: 0,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: request,
        }),
      );
    }

    const acknowledgements = sent.filter(
      (message) =>
        message.type === "hse:mutation-ack" &&
        message.requestId === "reference-duplicate",
    );
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements[1]).toEqual(acknowledgements[0]);
    const checkpoint = (
      acknowledgements[0].result as {
        checkpointHtml: string;
        slideCount: number;
      }
    );
    expect(checkpoint.slideCount).toBe(23);
    expect(checkpoint.checkpointHtml).not.toContain(
      "data-hse-editor-bridge",
    );
    expect(checkpoint.checkpointHtml).not.toContain("hse-live-overrides");
    const parsed = new DOMParser().parseFromString(
      checkpoint.checkpointHtml,
      "text/html",
    );
    expect(parsed.querySelectorAll("#stage > .slide")).toHaveLength(23);
  });

  it.each(["duplicate-object", "duplicate-slide"] as const)(
    "copies live overrides and reverses their delta for %s",
    (operation) => {
      const source = VALID_MINIMAL_DECK.replace(
        '<section class="slide" id="intro"><h1>Introduction</h1></section>',
        `<section class="slide" id="intro" data-hse-id="slide-old">
          <div data-hse-id="card-old"><h1 data-hse-id="title-old">Introduction</h1></div>
        </section>`,
      );
      const initialOverrides = {
        "card-old": { translate: "30px 20px", width: "420px" },
        "title-old": { color: "red", "font-size": "54px" },
      };
      const dom = new JSDOM(
        injectBridge(source, "session-1", { initialOverrides }),
        { runScripts: "outside-only" },
      );
      const sent: Array<Record<string, unknown>> = [];
      dom.window.postMessage = ((message: Record<string, unknown>) => {
        sent.push(message);
      }) as typeof dom.window.postMessage;
      const script = dom.window.document.querySelector<HTMLScriptElement>(
        "script[data-hse-editor-bridge]",
      )!;
      dom.window.eval(script.textContent);
      sent.length = 0;

      const message =
        operation === "duplicate-object"
          ? {
              type: "hse:duplicate-object",
              token: "session-1",
              requestId: "duplicate-edited",
              commandId: "duplicate-edited",
              label: "Duplicate edited object",
              targetId: "card-old",
            }
          : {
              type: "hse:duplicate-slide",
              token: "session-1",
              requestId: "duplicate-edited",
              commandId: "duplicate-edited",
              label: "Duplicate edited slide",
              slideIndex: 0,
            };
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: message,
        }),
      );

      const acknowledgement = sent.at(-1) as {
        result: {
          command: {
            before: {
              dom: unknown;
              overrideDelta: Record<string, null>;
            };
            after: {
              dom: unknown;
              overrideDelta: Record<string, Record<string, string>>;
            };
          };
          overrides: Record<string, Record<string, string>>;
        };
      };
      expect(sent.at(-1)).toMatchObject({
        type: "hse:mutation-ack",
        status: "success",
      });
      const delta = acknowledgement.result.command.after.overrideDelta;
      const copiedIds = Object.keys(delta);
      expect(copiedIds).toHaveLength(2);
      expect(Object.values(delta)).toEqual(
        expect.arrayContaining([
          initialOverrides["card-old"],
          initialOverrides["title-old"],
        ]),
      );
      expect(acknowledgement.result.command.before.overrideDelta).toEqual(
        Object.fromEntries(copiedIds.map((id) => [id, null])),
      );

      sent.length = 0;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: {
            type: "hse:apply-history",
            token: "session-1",
            requestId: "undo-edited-copy",
            direction: "before",
            command: acknowledgement.result.command,
          },
        }),
      );
      expect(
        (sent.at(-1) as { result: { overrides: Record<string, unknown> } })
          .result.overrides,
      ).toEqual(initialOverrides);

      sent.length = 0;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: {
            type: "hse:apply-history",
            token: "session-1",
            requestId: "redo-edited-copy",
            direction: "after",
            command: acknowledgement.result.command,
          },
        }),
      );
      const redone = sent.at(-1) as {
        result: { overrides: Record<string, Record<string, string>> };
      };
      expect(redone.result.overrides).toMatchObject(delta);

      sent.length = 0;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: {
            type: "hse:request-document",
            token: "session-1",
            requestId: "document-after-redo",
          },
        }),
      );
      const serialized = (
        sent.at(-1) as { type: string; html: string }
      ).html;
      const exported = prepareExport(
        new DOMParser().parseFromString(serialized, "text/html"),
        { overrides: redone.result.overrides },
      );
      const reopened = new DOMParser().parseFromString(exported, "text/html");
      for (const copiedId of copiedIds) {
        expect(
          reopened.querySelector(`[data-hse-id="${copiedId}"]`),
        ).not.toBeNull();
        expect(exported).toContain(`data-hse-id="${copiedId}"`);
      }
    },
  );

  it("uses only direct #stage slide children for runtime state and mutations", () => {
    const source = `<!doctype html><html><head><title>Scoped</title></head><body>
      <aside class="slide" id="off-stage">Off stage</aside>
      <main id="stage" style="width:1920px;height:1080px">
        <section class="slide active" id="deck-a">
          <div class="slide" id="nested"><p data-hse-id="nested-text">Nested</p></div>
        </section>
        <section class="slide" id="deck-b">B</section>
      </main>
    </body></html>`;
    const dom = new JSDOM(injectBridge(source, "session-1"), {
      runScripts: "outside-only",
      url: "https://deck.test/",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    expect(sent.find((message) => message.type === "hse:ready")).toMatchObject({
      slideCount: 2,
    });
    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:duplicate-slide",
          token: "session-1",
          requestId: "duplicate-direct",
          commandId: "duplicate-direct",
          label: "Duplicate direct slide",
          slideIndex: 1,
        },
      }),
    );

    expect(sent.at(-1)).toMatchObject({
      status: "success",
      result: { slideCount: 3, activeSlideIndex: 2 },
    });
    expect(dom.window.document.querySelectorAll("#stage > .slide")).toHaveLength(
      3,
    );
    expect(dom.window.document.querySelector("#nested")).not.toBeNull();
    expect(dom.window.document.querySelector("#off-stage")).not.toBeNull();
  });

  it("moves backward with Shift+Tab and commits inline text on blur", () => {
    const source = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      "<div><h1>First</h1><p>Second</p><p>Third</p></div>",
    );
    const dom = new JSDOM(injectBridge(source, "session-1"), {
      runScripts: "outside-only",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    for (const element of dom.window.document.querySelectorAll<HTMLElement>(
      "h1,p",
    )) {
      element.getBoundingClientRect = () => rect(10, 20, 300, 60);
    }
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    const second = [...dom.window.document.querySelectorAll("p")][0];
    second.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    sent.length = 0;
    second.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
        shiftKey: true,
      }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "hse:selection",
      text: "First",
    });

    const first = dom.window.document.querySelector<HTMLElement>("h1")!;
    first.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    first.textContent = "Blur committed";
    first.dispatchEvent(
      new dom.window.FocusEvent("focusout", {
        bubbles: true,
        relatedTarget: dom.window.document.body,
      }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "hse:inline-text-commit",
      before: "First",
      after: "Blur committed",
    });
    expect(first.textContent).toBe("First");
    expect(first.hasAttribute("contenteditable")).toBe(false);
  });

  it("serializes the pre-edit DOM and applies the shared complete cleanup", () => {
    const source = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-selection-anchor="start">Introduction</h1>',
    );
    const dom = new JSDOM(injectBridge(source, "session-1"), {
      runScripts: "outside-only",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    heading.textContent = "Uncommitted";
    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:request-document",
          token: "session-1",
          requestId: "recovery-before-commit",
        },
      }),
    );

    const html = (sent.at(-1) as { html: string }).html;
    expect(html).toContain("Introduction");
    expect(html).not.toContain("Uncommitted");
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain("data-hse-temp-id");
    expect(html).not.toContain("data-hse-selection-anchor");
    expect(html).not.toContain("data-hse-editor-bridge");
  });

  it.each([
    ["error", domEventFactory("error", "runtime error")],
    [
      "unhandledrejection",
      domEventFactory("unhandledrejection", "rejected promise"),
    ],
  ] as const)("reports typed %s diagnostics with direct slide context", (_kind, createEvent) => {
    const dom = new JSDOM(injectBridge(VALID_MINIMAL_DECK, "session-1"), {
      runScripts: "outside-only",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    dom.window.dispatchEvent(createEvent(dom.window));

    expect(sent.at(-1)).toMatchObject({
      type: "hse:error",
      kind: _kind,
      message: _kind === "error" ? "runtime error" : "rejected promise",
      slideIndex: 0,
    });
  });
  it("boots with validated overrides and preserves untouched entries through patch and undo", () => {
    const source = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Introduction</h1><p data-hse-id="node-2">Untouched</p>',
    );
    const result = injectBridge(source, "session-1", {
      initialOverrides: {
        "node-1": { color: "red" },
        "node-2": { "font-size": "24px" },
      },
    });
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;

    dom.window.eval(script.textContent);

    expect(
      dom.window.document.querySelector("#hse-live-overrides")?.textContent,
    ).toContain('[data-hse-id="node-1"]');
    expect(
      dom.window.document.querySelector("#hse-live-overrides")?.textContent,
    ).toContain('[data-hse-id="node-2"]');

    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:apply-patch",
          token: "session-1",
          requestId: "patch-restored",
          commandId: "patch-restored",
          label: "Patch restored",
          targetId: "node-1",
          patch: { color: "green" },
        },
      }),
    );
    const acknowledgement = sent[0] as {
      result: {
        command: Record<string, unknown>;
        overrides: Record<string, Record<string, string>>;
      };
    };

    expect(acknowledgement.result.overrides).toEqual({
      "node-1": { color: "green" },
      "node-2": { "font-size": "24px" },
    });
    expect(acknowledgement.result.command).toMatchObject({
      before: { override: { color: "red" } },
      after: { override: { color: "green" } },
    });

    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:apply-history",
          token: "session-1",
          requestId: "undo-restored",
          direction: "before",
          command: acknowledgement.result.command,
        },
      }),
    );

    expect(sent[0]).toMatchObject({
      status: "success",
      result: {
        overrides: {
          "node-1": { color: "red" },
          "node-2": { "font-size": "24px" },
        },
      },
    });
  });

  it("rejects unsafe initial overrides before bridge injection", () => {
    expect(() =>
      injectBridge(VALID_MINIMAL_DECK, "session-1", {
        initialOverrides: {
          "node-1": {
            color: "red; } body { display: none",
          },
        },
      }),
    ).toThrow("안전하지 않은 CSS override입니다.");
  });

  it("acks exact override entries without an uncorrelated selection event", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        '<h1 style="color: blue; transform: rotate(5deg)">Introduction</h1>',
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    const targetId = sent.find(
      (message) => message.type === "hse:selection",
    )!.targetId as string;
    sent.length = 0;

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:apply-patch",
          token: "session-1",
          requestId: "mutation-1",
          commandId: "patch-1",
          label: "Edit heading",
          targetId,
          patch: {
            text: "Updated",
            translateX: 20,
            color: "red",
            height: "auto",
          },
        },
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "hse:mutation-ack",
      requestId: "mutation-1",
      status: "success",
      result: {
        command: {
          id: "patch-1",
          kind: "patch",
          targetId: expect.any(String),
          before: {
            override: null,
            text: "Introduction",
          },
          after: {
            override: {
              color: "red",
              height: "auto",
              translate: "20px 0px",
            },
            text: "Updated",
          },
        },
        overrides: {
          [heading.getAttribute("data-hse-id")!]: {
            color: "red",
            height: "auto",
            translate: "20px 0px",
          },
        },
        selection: {
          targetId: heading.getAttribute("data-hse-id"),
          kind: "text",
          text: "Updated",
        },
      },
    });
    expect(heading.textContent).toBe("Updated");
    expect(heading.getAttribute("style")).toContain("transform: rotate(5deg)");
    expect(
      dom.window.document.querySelector("#hse-live-overrides")?.textContent,
    ).toContain("color: red");

    const command = (sent[0].result as { command: Record<string, unknown> })
      .command;
    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:apply-history",
          token: "session-1",
          requestId: "undo-1",
          direction: "before",
          command,
        },
      }),
    );

    expect(sent).toHaveLength(1);
    expect(heading.textContent).toBe("Introduction");
    expect(
      dom.window.document.querySelector("#hse-live-overrides"),
    ).toBeNull();
    expect(heading.getAttribute("style")).toContain("transform: rotate(5deg)");
  });

  it.each([
    {
      label: "missing target",
      targetId: "missing",
      patch: { color: "red" },
    },
    {
      label: "unsafe style",
      targetId: "selected",
      patch: { color: "red; } body { display: none" },
    },
  ])(
    "keeps DOM and overrides unchanged after an atomic $label failure",
    ({ targetId, patch }) => {
      const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
      const dom = new JSDOM(result, { runScripts: "outside-only" });
      const sent: Array<Record<string, unknown>> = [];
      dom.window.postMessage = ((message: Record<string, unknown>) => {
        sent.push(message);
      }) as typeof dom.window.postMessage;
      const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
      heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
      const script = dom.window.document.querySelector<HTMLScriptElement>(
        "script[data-hse-editor-bridge]",
      )!;
      dom.window.eval(script.textContent);
      heading.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          composed: true,
        }),
      );
      const selectedId = sent.find(
        (message) => message.type === "hse:selection",
      )!.targetId as string;
      const before = dom.window.document.body.innerHTML;
      sent.length = 0;

      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: {
            type: "hse:apply-patch",
            token: "session-1",
            requestId: "mutation-failed",
            commandId: "patch-failed",
            label: "Invalid patch",
            targetId: targetId === "selected" ? selectedId : targetId,
            patch,
          },
        }),
      );

      expect(sent.at(-1)).toMatchObject({
        type: "hse:mutation-ack",
        requestId: "mutation-failed",
        status: "error",
      });
      expect(dom.window.document.body.innerHTML).toBe(before);
      expect(
        dom.window.document.querySelector("#hse-live-overrides"),
      ).toBeNull();
      expect(heading.hasAttribute("data-hse-id")).toBe(false);
    },
  );

  it("cancels and proposes inline text edits with deck navigation suppressed", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const deckKey = vi.fn();
    dom.window.document.addEventListener("keydown", deckKey);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );

    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        composed: true,
      }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    expect(heading.getAttribute("contenteditable")).toBe("true");
    heading.textContent = "Cancelled";
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    expect(heading.textContent).toBe("Introduction");
    expect(heading.hasAttribute("contenteditable")).toBe(false);

    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    heading.textContent = "Committed";
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        ctrlKey: true,
      }),
    );

    expect(heading.textContent).toBe("Introduction");
    expect(sent.at(-1)).toMatchObject({
      type: "hse:inline-text-commit",
      before: "Introduction",
      after: "Committed",
    });
    expect(deckKey).not.toHaveBeenCalled();
  });

  it("flushes an active inline edit before acknowledging an export request", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    heading.textContent = "Exported inline text";
    sent.length = 0;

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:commit-inline-edit",
          token: "session-1",
          requestId: "inline-export",
        },
      }),
    );

    expect(sent.slice(-2)).toEqual([
      expect.objectContaining({
        type: "hse:inline-text-commit",
        before: "Introduction",
        after: "Exported inline text",
      }),
      {
        type: "hse:inline-text-flush",
        token: "session-1",
        requestId: "inline-export",
      },
    ]);
    expect(heading.textContent).toBe("Introduction");
    expect(heading.hasAttribute("contenteditable")).toBe(false);
  });

  it("restores nested markup before cancel or plain-text commit acknowledgement", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        "<h1><span>Intro <strong>duction</strong></span></h1>",
      ).replace(
        "<p>Fallback label</p>",
        "<table><tbody><tr><td><em>Cell</em></td></tr></tbody></table>",
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    const table = dom.window.document.querySelector<HTMLElement>("table")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    table.getBoundingClientRect = () => rect(10, 100, 300, 120);
    const headingMarkup = heading.innerHTML;
    const tableMarkup = table.innerHTML;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    for (const element of [heading, table]) {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          composed: true,
        }),
      );
      element.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
      element.innerHTML = "<span>Changed</span>";
      element.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
    }
    expect(heading.innerHTML).toBe(headingMarkup);
    expect(table.innerHTML).toBe(tableMarkup);

    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        composed: true,
      }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    heading.innerHTML = "<span>Plain <b>replacement</b></span>";
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        ctrlKey: true,
      }),
    );

    expect(heading.innerHTML).toBe(headingMarkup);
    expect(sent.at(-1)).toMatchObject({
      type: "hse:inline-text-commit",
      after: "Plain replacement",
    });
    const proposal = sent.at(-1)!;
    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:apply-patch",
          token: "session-1",
          requestId: "text-ack-1",
          commandId: "text-1",
          label: "Edit text",
          targetId: proposal.targetId,
          patch: { text: proposal.after },
        },
      }),
    );
    expect(sent).toHaveLength(1);
    expect(heading.innerHTML).toBe("Plain replacement");
  });

  it("normalizes duplicate target and parent persistent ids before runtime lookup", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        `
          <div data-hse-id="parent-duplicate">
            <h1 data-hse-id="target-duplicate">Introduction</h1>
          </div>
          <div data-hse-id="parent-duplicate">
            <p data-hse-id="target-duplicate">Second</p>
          </div>`,
      ),
      "session-1",
    );
    const parsed = new DOMParser().parseFromString(result, "text/html");
    const persistentIds = [
      ...parsed.querySelectorAll<HTMLElement>("[data-hse-id]"),
    ].map((element) => element.dataset.hseId);

    expect(new Set(persistentIds).size).toBe(persistentIds.length);
    expect(
      parsed.querySelectorAll('[data-hse-id="parent-duplicate"]'),
    ).toHaveLength(1);
    expect(
      parsed.querySelectorAll('[data-hse-id="target-duplicate"]'),
    ).toHaveLength(1);
  });

  it("retries a generated persistent id that collides with the registry", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        '<div data-hse-id="existing-id"></div><h1>Introduction</h1>',
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const ids = ["temp-seed", "existing-id", "fresh-id"];
    Object.defineProperty(dom.window.crypto, "randomUUID", {
      configurable: true,
      value: () => ids.shift() ?? "fallback-id",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        composed: true,
      }),
    );
    const targetId = sent.at(-1)!.targetId;
    sent.length = 0;

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:apply-patch",
          token: "session-1",
          requestId: "patch-collision",
          commandId: "patch-collision",
          label: "Patch",
          targetId,
          patch: { color: "red" },
        },
      }),
    );

    expect(sent[0]).toMatchObject({
      status: "success",
      result: {
        command: { targetId: "fresh-id" },
      },
    });
    expect(
      dom.window.document.querySelectorAll('[data-hse-id="existing-id"]'),
    ).toHaveLength(1);
  });

  it("ascends selection depth with Escape and selects a sibling with Tab", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        '<div class="card"><h1><span>Introduction</span></h1></div><p>Sibling</p>',
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const card = dom.window.document.querySelector<HTMLElement>(".card")!;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    const span = dom.window.document.querySelector<HTMLElement>("span")!;
    const sibling = dom.window.document.querySelector<HTMLElement>(
      "#intro > p",
    )!;
    card.getBoundingClientRect = () => rect(10, 20, 600, 400);
    heading.getBoundingClientRect = () => rect(30, 40, 300, 60);
    span.getBoundingClientRect = () => rect(40, 50, 100, 20);
    sibling.getBoundingClientRect = () => rect(30, 450, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    span.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    span.dispatchEvent(
      new dom.window.MouseEvent("dblclick", {
        bubbles: true,
        composed: true,
      }),
    );
    expect(heading.getAttribute("contenteditable")).toBe("true");
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "hse:selection",
      kind: "container",
    });

    card.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
      }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "hse:selection",
      kind: "text",
      text: "Sibling",
    });
  });

  it("edits the nearest text element after a real double-click event sequence", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        `<div class="evidence-layout">
          <div class="evidence-notes">
            <div class="evidence-note">
              <strong>Section label</strong>
              <p>Editable body copy</p>
              <a href="#">Linked body copy</a>
            </div>
          </div>
        </div>`,
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const layout = dom.window.document.querySelector<HTMLElement>(
      ".evidence-layout",
    )!;
    const notes = dom.window.document.querySelector<HTMLElement>(
      ".evidence-notes",
    )!;
    const note = dom.window.document.querySelector<HTMLElement>(
      ".evidence-note",
    )!;
    const strong = dom.window.document.querySelector<HTMLElement>("strong")!;
    const paragraph = dom.window.document.querySelector<HTMLElement>("p")!;
    const link = dom.window.document.querySelector<HTMLElement>("a")!;
    layout.getBoundingClientRect = () => rect(10, 20, 900, 500);
    notes.getBoundingClientRect = () => rect(450, 40, 400, 400);
    note.getBoundingClientRect = () => rect(470, 60, 360, 160);
    strong.getBoundingClientRect = () => rect(490, 75, 220, 28);
    paragraph.getBoundingClientRect = () => rect(490, 110, 320, 80);
    link.getBoundingClientRect = () => rect(490, 200, 240, 28);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    paragraph.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    paragraph.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    paragraph.dispatchEvent(
      new dom.window.MouseEvent("dblclick", {
        bubbles: true,
        composed: true,
      }),
    );

    expect(paragraph).toHaveAttribute("contenteditable", "true");
    expect(layout).not.toHaveAttribute("contenteditable");
    paragraph.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );

    strong.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    strong.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    strong.dispatchEvent(
      new dom.window.MouseEvent("dblclick", {
        bubbles: true,
        composed: true,
      }),
    );
    expect(strong).toHaveAttribute("contenteditable", "true");
    strong.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );

    link.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    link.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    link.dispatchEvent(
      new dom.window.MouseEvent("dblclick", {
        bubbles: true,
        composed: true,
      }),
    );
    expect(link).toHaveAttribute("contenteditable", "true");
    dom.window.close();
  });

  it("reports stage and sibling snap targets with the selected object", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        "<h1>Introduction</h1><p>Sibling</p>",
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const stage = dom.window.document.querySelector<HTMLElement>("#stage")!;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    const sibling = dom.window.document.querySelector<HTMLElement>("#intro p")!;
    stage.getBoundingClientRect = () => rect(0, 0, 1920, 1080);
    heading.getBoundingClientRect = () => rect(100, 100, 300, 60);
    sibling.getBoundingClientRect = () => rect(500, 200, 200, 80);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        composed: true,
      }),
    );

    expect(sent.at(-1)).toMatchObject({
      type: "hse:selection",
      snapTargets: expect.arrayContaining([
        { axis: "x", value: 0, kind: "stage-start" },
        { axis: "x", value: 960, kind: "stage-center" },
        { axis: "x", value: 500, kind: "object-start" },
        { axis: "x", value: 600, kind: "object-center" },
        { axis: "y", value: 280, kind: "object-end" },
      ]),
    });
  });

  it("normalizes transformed deck bounds into logical stage coordinates", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        "<h1>Introduction</h1><p>Sibling</p>",
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const stage = dom.window.document.querySelector<HTMLElement>("#stage")!;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    const sibling = dom.window.document.querySelector<HTMLElement>("#intro p")!;
    Object.defineProperties(stage, {
      offsetWidth: { configurable: true, value: 1920 },
      offsetHeight: { configurable: true, value: 1080 },
    });
    stage.getBoundingClientRect = () => rect(10, 20, 960, 540);
    heading.getBoundingClientRect = () => rect(110, 120, 150, 30);
    sibling.getBoundingClientRect = () => rect(310, 220, 100, 40);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        composed: true,
      }),
    );

    expect(sent.at(-1)).toMatchObject({
      type: "hse:selection",
      bounds: { x: 200, y: 200, width: 300, height: 60 },
      snapTargets: expect.arrayContaining([
        { axis: "x", value: 0, kind: "stage-start" },
        { axis: "x", value: 960, kind: "stage-center" },
        { axis: "x", value: 600, kind: "object-start" },
        { axis: "x", value: 700, kind: "object-center" },
        { axis: "y", value: 480, kind: "object-end" },
      ]),
    });
  });

  it("keeps a reordered slide active when the deck engine captured the original order", async () => {
    const source = VALID_MINIMAL_DECK.replace(
      "</body>",
      `<script>
        (() => {
          const slides = [...document.querySelectorAll(".slide")];
          let current = 0;
          addEventListener("hashchange", () => {
            const index = Number.parseInt(location.hash.slice(1), 10) - 1;
            if (index < 0 || index >= slides.length || index === current) return;
            current = index;
            slides.forEach((slide, slideIndex) => {
              slide.classList.toggle("active", slideIndex === current);
            });
          });
        })();
      </script></body>`,
    );
    const result = injectBridge(source, "session-1");
    const dom = new JSDOM(result, {
      runScripts: "outside-only",
      url: "https://deck.test/#1",
    });
    const scripts = [
      ...dom.window.document.querySelectorAll<HTMLScriptElement>("script"),
    ];
    const engine = scripts.find(
      (script) => !script.hasAttribute("data-hse-editor-bridge"),
    )!;
    const bridge = scripts.find((script) =>
      script.hasAttribute("data-hse-editor-bridge"),
    )!;
    dom.window.eval(engine.textContent);
    dom.window.eval(bridge.textContent);

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:reorder-slide",
          token: "session-1",
          requestId: "reorder-stale-engine",
          commandId: "reorder-stale-engine",
          label: "Reorder slide",
          fromIndex: 0,
          toIndex: 1,
        },
      }),
    );
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    expect(
      [...dom.window.document.querySelectorAll(".slide")].map(
        (slide) => slide.textContent?.trim(),
      ),
    ).toEqual(["Fallback label", "Introduction"]);
    expect(
      dom.window.document.querySelector(".slide.active")?.textContent?.trim(),
    ).toBe("Introduction");
    expect(dom.window.location.hash).toBe("#2");
  });

  it("centralizes structural slide activation, hash, and cleared selection in ACKs", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const dom = new JSDOM(result, { runScripts: "outside-only", url: "https://deck.test/" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    const mutate = (data: Record<string, unknown>) => {
      sent.length = 0;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          data: { token: "session-1", ...data },
        }),
      );
      expect(sent).toHaveLength(1);
      return sent[0];
    };

    const duplicate = mutate({
      type: "hse:duplicate-slide",
      requestId: "duplicate-1",
      commandId: "duplicate-slide-1",
      label: "Duplicate slide",
      slideIndex: 0,
    });
    expect(duplicate).toMatchObject({
      status: "success",
      result: {
        slideCount: 3,
        activeSlideIndex: 1,
        selection: null,
      },
    });
    expect(dom.window.location.hash).toBe("#2");
    expect(
      [...dom.window.document.querySelectorAll(".slide")].map((slide) =>
        slide.classList.contains("active"),
      ),
    ).toEqual([false, true, false]);

    const deleted = mutate({
      type: "hse:delete-slide",
      requestId: "delete-1",
      commandId: "delete-slide-1",
      label: "Delete slide",
      slideIndex: 1,
    });
    expect(deleted).toMatchObject({
      status: "success",
      result: {
        slideCount: 2,
        activeSlideIndex: 1,
        selection: null,
      },
    });
    expect(dom.window.location.hash).toBe("#2");

    const reordered = mutate({
      type: "hse:reorder-slide",
      requestId: "reorder-1",
      commandId: "reorder-slide-1",
      label: "Reorder slide",
      fromIndex: 0,
      toIndex: 1,
    });
    expect(reordered).toMatchObject({
      status: "success",
      result: {
        activeSlideIndex: 1,
        selection: null,
      },
    });
    expect(dom.window.location.hash).toBe("#2");
  });

  it("keeps the active slide when deleting its selected object", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const dom = new JSDOM(result, {
      runScripts: "outside-only",
      url: "https://deck.test/",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const paragraph = dom.window.document.querySelector<HTMLElement>(
      ".slide:nth-of-type(2) p",
    )!;
    paragraph.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:select-slide",
          token: "session-1",
          slideIndex: 1,
        },
      }),
    );
    paragraph.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        composed: true,
      }),
    );
    const targetId = sent.at(-1)!.targetId;
    sent.length = 0;

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:delete-object",
          token: "session-1",
          requestId: "delete-object-1",
          commandId: "delete-object-1",
          label: "Delete object",
          targetId,
        },
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      status: "success",
      result: {
        activeSlideIndex: 1,
        selection: null,
      },
    });
    expect(dom.window.location.hash).toBe("#2");
  });

  it("keeps build-step content visible while editing and restores it on reset", async () => {
    const source = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1>Introduction</h1><div data-step class="revealed">First build</div>',
    ).replace(
      "<p>Fallback label</p>",
      '<p>Fallback label</p><div data-step>Second build</div>',
    );
    const dom = new JSDOM(injectBridge(source, "session-1"), {
      runScripts: "outside-only",
      url: "https://deck.test/",
    });
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);

    const steps = [
      ...dom.window.document.querySelectorAll<HTMLElement>("[data-step]"),
    ];
    expect(steps).toHaveLength(2);
    expect(steps.every((step) => step.classList.contains("revealed"))).toBe(
      true,
    );

    steps.forEach((step) => step.replaceWith(step.cloneNode(true)));
    const recreatedSteps = [
      ...dom.window.document.querySelectorAll<HTMLElement>("[data-step]"),
    ];

    recreatedSteps[1].classList.remove("revealed");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(recreatedSteps[1]).toHaveClass("revealed");

    const promoted = dom.window.document.createElement("div");
    promoted.textContent = "Promoted build";
    dom.window.document.querySelector("#stage > .slide")!.append(promoted);
    promoted.setAttribute("data-step", "");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(promoted).toHaveClass("revealed");

    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: {
          type: "hse:request-document",
          token: "session-1",
          requestId: "build-step-document",
        },
      }),
    );
    const html = sent.at(-1)?.html as string;
    expect(html).not.toContain("data-hse-build-step-origin");
    expect(html).not.toMatch(/data-step[^>]*class="revealed"/);

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: { type: "hse:reset", token: "session-1" },
      }),
    );
    expect(recreatedSteps[0]).toHaveClass("revealed");
    expect(recreatedSteps[1]).not.toHaveClass("revealed");
    expect(promoted).not.toHaveClass("revealed");
    expect(
      dom.window.document.querySelector("[data-hse-build-step-origin]"),
    ).toBeNull();
    dom.window.close();
  });

  it("adds one temporary bridge marker without changing slide count", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const document = new DOMParser().parseFromString(result, "text/html");

    expect(document.querySelectorAll("script[data-hse-editor-bridge]")).toHaveLength(
      1,
    );
    expect(document.querySelectorAll(".slide")).toHaveLength(2);
    expect(result.toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });

  it("rejects a source that is not a valid slide deck", () => {
    expect(() => injectBridge(INVALID_MISSING_STAGE, "session-1")).toThrow(
      "#stage",
    );
  });

  it("rejects an empty session token before injection", () => {
    expect(() => injectBridge(VALID_MINIMAL_DECK, "")).toThrow();
  });

  it("intercepts navigation before original window capture handlers", async () => {
    const result = injectBridge(deckWithOriginalCaptureHandlers(), "session-1");
    const dom = new JSDOM(result, { runScripts: "dangerously" });
    await waitForLoad(dom);

    dom.window.document.querySelector("h1")!.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }),
    );

    expect(dom.window.deckKeyCount).toBe(0);
  });

  it("defers ready when a head script dispatches input before the deck exists", async () => {
    const source = VALID_MINIMAL_DECK.replace(
      "</head>",
      `<script>
        document.documentElement.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true
        }));
        window.readySeenBeforeBody = window.bridgeMessages.some(
          (message) => message.type === "hse:ready"
        );
      </script></head>`,
    );
    const sent: Array<Record<string, unknown>> = [];
    const result = injectBridge(source, "session-1");
    const dom = new JSDOM(result, {
      runScripts: "dangerously",
      beforeParse(window: Window & typeof globalThis) {
        Object.assign(window, { bridgeMessages: sent });
        window.postMessage = ((message: Record<string, unknown>) => {
          sent.push(message);
        }) as typeof window.postMessage;
      },
    });
    await waitForLoad(dom);

    expect(dom.window.readySeenBeforeBody).toBe(false);
    expect(sent.filter((message) => message.type === "hse:ready")).toEqual([
      expect.objectContaining({ slideCount: 2 }),
    ]);
  });

  it("removes interception and restores original deck input on reset", async () => {
    const result = injectBridge(deckWithOriginalCaptureHandlers(), "session-1");
    const sent: Array<Record<string, unknown>> = [];
    const dom = new JSDOM(result, {
      runScripts: "dangerously",
      beforeParse(window: Window & typeof globalThis) {
        window.postMessage = ((message: Record<string, unknown>) => {
          sent.push(message);
        }) as typeof window.postMessage;
      },
    });
    await waitForLoad(dom);
    const heading = dom.window.document.querySelector("h1")!;

    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );
    heading.dispatchEvent(
      new dom.window.MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
      }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }),
    );
    expect(dom.window.deckClickCount).toBe(0);
    expect(dom.window.deckDoubleClickCount).toBe(0);
    expect(dom.window.deckKeyCount).toBe(0);

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { type: "hse:reset", token: "session-1" },
        source: dom.window,
      }),
    );

    expect(
      dom.window.document.querySelector("script[data-hse-editor-bridge]"),
    ).toBeNull();
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );
    heading.dispatchEvent(
      new dom.window.MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
      }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
      }),
    );
    expect(dom.window.deckClickCount).toBe(1);
    expect(dom.window.deckDoubleClickCount).toBe(1);
    expect(dom.window.deckKeyCount).toBe(1);

    const messageCount = sent.length;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:request-document",
          token: "session-1",
          requestId: "after-reset",
        },
        source: dom.window,
      }),
    );
    expect(sent).toHaveLength(messageCount);
  });

  it("executes serialized helpers without closures and intercepts deck input", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        '<div class="card"><h1><span>Introduction</span></h1></div>',
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: unknown[] = [];
    dom.window.postMessage = ((message: unknown) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;

    const card = dom.window.document.querySelector<HTMLElement>(".card")!;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    const span = dom.window.document.querySelector<HTMLElement>("span")!;
    card.getBoundingClientRect = () => rect(10, 20, 600, 400);
    heading.getBoundingClientRect = () => rect(30, 40, 300, 60);
    span.getBoundingClientRect = () => rect(40, 50, 100, 20);

    const deckClick = vi.fn();
    const deckDoubleClick = vi.fn();
    const deckKey = vi.fn();
    dom.window.document.addEventListener("click", deckClick);
    dom.window.document.addEventListener("dblclick", deckDoubleClick);
    dom.window.document.addEventListener("keydown", deckKey);

    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    span.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    span.dispatchEvent(
      new dom.window.MouseEvent("dblclick", { bubbles: true, composed: true }),
    );
    heading.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }),
    );
    span.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowRight",
        shiftKey: true,
      }),
    );

    expect(deckClick).not.toHaveBeenCalled();
    expect(deckDoubleClick).not.toHaveBeenCalled();
    expect(deckKey).not.toHaveBeenCalled();
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "hse:ready",
          token: "session-1",
          slideCount: 2,
        }),
        expect.objectContaining({
          type: "hse:selection",
          token: "session-1",
          targetId: expect.any(String),
          kind: "container",
          bounds: { x: 10, y: 20, width: 600, height: 400 },
        }),
        expect.objectContaining({
          type: "hse:selection",
          token: "session-1",
          kind: "text",
          bounds: { x: 30, y: 40, width: 300, height: 60 },
        }),
      ]),
    );
  });

  it("keeps closing-script text and Unicode separators inside the token", () => {
    const token = 'session</script><script data-escaped="no">bad()</script>\u2028\u2029';
    const result = injectBridge(VALID_MINIMAL_DECK, token);
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: unknown[] = [];
    dom.window.postMessage = ((message: unknown) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;

    expect(
      dom.window.document.querySelectorAll("script[data-hse-editor-bridge]"),
    ).toHaveLength(1);
    expect(dom.window.document.querySelector("script[data-escaped]")).toBeNull();

    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    expect(() => dom.window.eval(script.textContent)).not.toThrow();
    expect(sent[0]).toMatchObject({ type: "hse:ready", token });
  });

  it("assigns a stable temporary id when randomUUID is unavailable", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    Object.defineProperty(dom.window.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });

    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => rect(10, 20, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    heading.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );

    const selections = sent.filter(
      (message) => message.type === "hse:selection",
    );
    expect(selections).toHaveLength(2);
    expect(selections[0].targetId).toMatch(/^hse-/);
    expect(selections[1].targetId).toBe(selections[0].targetId);
  });

  it("replaces duplicate reserved temporary ids with session-owned ids", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        '<h1 data-hse-temp-id="reserved">Introduction</h1>',
      ).replace(
        "<p>Fallback label</p>",
        '<h2 data-hse-temp-id="reserved">Fallback label</h2>',
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;

    const headings = [
      ...dom.window.document.querySelectorAll<HTMLElement>("h1,h2"),
    ];
    headings[0].getBoundingClientRect = () => rect(10, 20, 300, 60);
    headings[1].getBoundingClientRect = () => rect(10, 100, 300, 60);
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    for (const heading of headings) {
      heading.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
      );
    }

    const targetIds = sent
      .filter((message) => message.type === "hse:selection")
      .map((message) => message.targetId);
    expect(targetIds).toHaveLength(2);
    expect(new Set(targetIds).size).toBe(2);
    expect(targetIds).not.toContain("reserved");

    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:request-document",
          token: "session-1",
          requestId: "temp-id-cleanup",
        },
        source: dom.window,
      }),
    );
    expect(sent[0].requestId).toBe("temp-id-cleanup");
    expect(sent[0].html).not.toContain("data-hse-temp-id");
  });

  it("handles only token-matched selection and document scaffold commands", () => {
    const result = injectBridge(
      VALID_MINIMAL_DECK.replace(
        "<h1>Introduction</h1>",
        '<div class="card"><h1><span>Introduction</span></h1></div>',
      ),
      "session-1",
    );
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;

    const card = dom.window.document.querySelector<HTMLElement>(".card")!;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    const span = dom.window.document.querySelector<HTMLElement>("span")!;
    card.getBoundingClientRect = () => rect(10, 20, 600, 400);
    heading.getBoundingClientRect = () => rect(30, 40, 300, 60);
    span.getBoundingClientRect = () => rect(40, 50, 100, 20);

    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    span.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, composed: true }),
    );
    sent.length = 0;

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:select-depth",
          token: "wrong-session",
          depth: 1,
        },
        source: dom.window,
      }),
    );
    expect(sent).toHaveLength(0);

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:select-depth",
          token: "session-1",
          depth: 1,
        },
        source: dom.window,
      }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "hse:selection",
      kind: "text",
      bounds: { x: 30, y: 40, width: 300, height: 60 },
    });

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:request-document",
          token: "session-1",
          requestId: "document-scaffold",
        },
        source: dom.window,
      }),
    );
    const documentMessage = sent.at(-1);
    expect(documentMessage?.type).toBe("hse:document");
    expect(documentMessage?.requestId).toBe("document-scaffold");
    expect(documentMessage?.html).not.toContain("data-hse-editor-bridge");
    expect(documentMessage?.html).not.toContain("data-hse-temp-id");

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { type: "hse:reset", token: "session-1" },
        source: dom.window,
      }),
    );
    expect(
      dom.window.document.querySelector("[data-hse-temp-id]"),
    ).toBeNull();
    sent.length = 0;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:select-depth",
          token: "session-1",
          depth: 1,
        },
        source: dom.window,
      }),
    );
    expect(sent).toHaveLength(0);
  });

  it("ignores a correct-token command from a non-parent source", () => {
    const result = injectBridge(VALID_MINIMAL_DECK, "session-1");
    const dom = new JSDOM(result, { runScripts: "outside-only" });
    const other = new JSDOM("<!doctype html><p>other</p>");
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    sent.length = 0;

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "hse:request-document",
          token: "session-1",
          requestId: "wrong-source",
        },
        source: other.window,
      }),
    );

    expect(sent).toHaveLength(0);
  });
});

describe("declareInjectedHelpers", () => {
  it("declares a single binding when the bundler kept the source name", () => {
    function keptName(value: number) {
      return value + 1;
    }
    expect(declareInjectedHelpers({ keptName })).toEqual([
      `const keptName = ${keptName.toString()};`,
    ]);
  });

  it("aliases the bundled name when minification renamed the binding", () => {
    const renamed = function eC(value: number) {
      return value;
    };
    expect(
      declareInjectedHelpers({ normalizePersistentIds: renamed }),
    ).toEqual([
      `const normalizePersistentIds = ${renamed.toString()};`,
      "const eC = normalizePersistentIds;",
    ]);
  });

  it("resolves a sibling call made under the minified name", () => {
    const $S = function $S(value: number) {
      return value * 2;
    };
    const normalize = function eC(value: number) {
      // A minified build calls its sibling by the minified name, which only
      // resolves because the alias is declared in the same injected scope.
      return $S(value) + 1;
    };
    const script = [
      ...declareInjectedHelpers({
        ensurePersistentId: $S,
        normalizePersistentIds: normalize,
      }),
      "return normalizePersistentIds(4);",
    ].join("\n");
    expect(new Function(script)()).toBe(9);
  });

  it("resolves a call made under the original name", () => {
    const normalize = function eC(value: number) {
      return value + 5;
    };
    const script = [
      ...declareInjectedHelpers({ normalizePersistentIds: normalize }),
      "return normalizePersistentIds(1);",
    ].join("\n");
    expect(new Function(script)()).toBe(6);
  });

  it("never shadows a helper whose source name equals another bundled name", () => {
    const first = function second(value: number) {
      return value;
    };
    const second = function other(value: number) {
      return value;
    };
    const lines = declareInjectedHelpers({ first, second });
    expect(lines.filter((line) => line.startsWith("const second ="))).toEqual([
      `const second = ${second.toString()};`,
    ]);
    expect(lines).toContain("const other = second;");
  });

  it("skips an anonymous helper instead of emitting invalid syntax", () => {
    const anonymous = ((value: number) => value) as (value: number) => number;
    Object.defineProperty(anonymous, "name", { value: "" });
    expect(declareInjectedHelpers({ helper: anonymous })).toEqual([
      `const helper = ${anonymous.toString()};`,
    ]);
  });
});
