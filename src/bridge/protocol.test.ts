import { describe, expect, it } from "vitest";
import {
  FrameToParentMessageSchema,
  ParentToFrameMessageSchema,
} from "./protocol";

describe("FrameToParentMessageSchema", () => {
  it.each([
    {
      status: "success",
      result: {
        command: {
          id: "patch-1",
          label: "Move object",
          kind: "patch",
          targetId: "node-1",
          before: { translateX: 0 },
          after: { translateX: 20 },
        },
        overrides: {
          "node-1": { translate: "20px 0px" },
        },
        checkpointHtml:
          '<!doctype html><html><body><main id="stage"><section class="slide"></section><section class="slide"></section></main></body></html>',
        slideCount: 2,
        activeSlideIndex: 0,
        selection: null,
      },
    },
    {
      status: "error",
      error: {
        code: "TARGET_NOT_FOUND",
        message: "편집 대상을 찾을 수 없습니다.",
      },
    },
  ])("accepts a correlated mutation $status ACK", (ack) => {
    expect(
      FrameToParentMessageSchema.parse({
        type: "hse:mutation-ack",
        token: "session-1",
        requestId: "mutation-1",
        ...ack,
      }),
    ).toMatchObject({
      type: "hse:mutation-ack",
      requestId: "mutation-1",
      status: ack.status,
    });
  });

  it("requires post-mutation selection state on success ACKs", () => {
    expect(() =>
      FrameToParentMessageSchema.parse({
        type: "hse:mutation-ack",
        token: "session-1",
        requestId: "mutation-1",
        status: "success",
        result: {
          command: {
            id: "patch-1",
            label: "Move object",
            kind: "patch",
            targetId: "node-1",
            before: { override: null },
            after: { override: { translate: "20px 0px" } },
          },
          overrides: {
            "node-1": { translate: "20px 0px" },
          },
          slideCount: 2,
          activeSlideIndex: 0,
        },
      }),
    ).toThrow();
  });

  it("requires a bridge-free post-mutation HTML checkpoint on success ACKs", () => {
    expect(() =>
      FrameToParentMessageSchema.parse({
        type: "hse:mutation-ack",
        token: "session-1",
        requestId: "mutation-1",
        status: "success",
        result: {
          command: {
            id: "patch-1",
            label: "Move object",
            kind: "patch",
            targetId: "node-1",
            before: { override: null },
            after: { override: { translate: "20px 0px" } },
          },
          overrides: {
            "node-1": { translate: "20px 0px" },
          },
          slideCount: 2,
          activeSlideIndex: 0,
          selection: null,
        },
      }),
    ).toThrow();
  });

  it("rejects messages without the session token", () => {
    expect(() =>
      FrameToParentMessageSchema.parse({
        type: "hse:ready",
        slideCount: 2,
      }),
    ).toThrow();
  });

  it("accepts a measured selection message", () => {
    expect(
      FrameToParentMessageSchema.parse({
        type: "hse:selection",
        token: "session-1",
        targetId: "node-4",
        path: ["section.slide", "h2.h2"],
        bounds: { x: 100, y: 200, width: 500, height: 120 },
        kind: "text",
      }).type,
    ).toBe("hse:selection");
  });

  it("accepts editor navigation keys with modifier state", () => {
    expect(
      FrameToParentMessageSchema.parse({
        type: "hse:editor-key",
        token: "session-1",
        key: "ArrowRight",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toMatchObject({
      type: "hse:editor-key",
      key: "ArrowRight",
      ctrlKey: true,
      shiftKey: true,
    });
  });

  it("accepts an inline text commit proposal without mutating acknowledgement", () => {
    expect(
      FrameToParentMessageSchema.parse({
        type: "hse:inline-text-commit",
        token: "session-1",
        targetId: "node-1",
        before: "Before",
        after: "After",
      }),
    ).toMatchObject({
      type: "hse:inline-text-commit",
      targetId: "node-1",
      before: "Before",
      after: "After",
    });
  });

  it.each(["error", "unhandledrejection"] as const)(
    "accepts a typed %s diagnostic with slide context",
    (kind) => {
      expect(
        FrameToParentMessageSchema.parse({
          type: "hse:error",
          token: "session-1",
          kind,
          message: "runtime failed",
          slideIndex: 1,
        }),
      ).toMatchObject({
        type: "hse:error",
        kind,
        slideIndex: 1,
      });
    },
  );

  it("requires a request ID on document responses", () => {
    expect(
      FrameToParentMessageSchema.parse({
        type: "hse:document",
        token: "session-1",
        requestId: "document-1",
        html: "<!doctype html><html></html>",
      }),
    ).toMatchObject({
      type: "hse:document",
      requestId: "document-1",
    });

    expect(() =>
      FrameToParentMessageSchema.parse({
        type: "hse:document",
        token: "session-1",
        html: "<!doctype html><html></html>",
      }),
    ).toThrow();
  });

  it("validates correlated inline text flush messages", () => {
    expect(
      ParentToFrameMessageSchema.parse({
        type: "hse:commit-inline-edit",
        token: "session-1",
        requestId: "inline-1",
      }),
    ).toMatchObject({
      type: "hse:commit-inline-edit",
      requestId: "inline-1",
    });
    expect(
      FrameToParentMessageSchema.parse({
        type: "hse:inline-text-flush",
        token: "session-1",
        requestId: "inline-1",
      }),
    ).toMatchObject({
      type: "hse:inline-text-flush",
      requestId: "inline-1",
    });
  });

  it("rejects an empty session token", () => {
    expect(() =>
      FrameToParentMessageSchema.parse({
        type: "hse:ready",
        token: "",
        slideCount: 2,
      }),
    ).toThrow();
  });
});

describe("ParentToFrameMessageSchema", () => {
  it.each([
    {
      type: "hse:select-depth",
      token: "session-1",
      depth: 2,
    },
    {
      type: "hse:select-slide",
      token: "session-1",
      slideIndex: 1,
    },
    {
      type: "hse:commit-inline-edit",
      token: "session-1",
      requestId: "inline-1",
    },
    {
      type: "hse:edit-at-point",
      token: "session-1",
      x: 689.5,
      y: 237.9,
    },
    {
      type: "hse:apply-patch",
      token: "session-1",
      requestId: "mutation-transform",
      commandId: "transform-1",
      label: "Transform object",
      targetId: "node-1",
      patch: {
        translateX: 10,
        translateY: -5,
        width: 320,
        height: "auto",
      },
    },
    {
      type: "hse:duplicate-object",
      token: "session-1",
      requestId: "mutation-duplicate-object",
      commandId: "duplicate-object-1",
      label: "Duplicate object",
      targetId: "node-1",
    },
    {
      type: "hse:delete-object",
      token: "session-1",
      requestId: "mutation-delete-object",
      commandId: "delete-object-1",
      label: "Delete object",
      targetId: "node-1",
    },
    {
      type: "hse:reorder-slide",
      token: "session-1",
      requestId: "mutation-reorder-slide",
      commandId: "reorder-slide-1",
      label: "Reorder slide",
      fromIndex: 0,
      toIndex: 1,
    },
    {
      type: "hse:duplicate-slide",
      token: "session-1",
      requestId: "mutation-duplicate-slide",
      commandId: "duplicate-slide-1",
      label: "Duplicate slide",
      slideIndex: 0,
    },
    {
      type: "hse:delete-slide",
      token: "session-1",
      requestId: "mutation-delete-slide",
      commandId: "delete-slide-1",
      label: "Delete slide",
      slideIndex: 1,
    },
    {
      type: "hse:request-document",
      token: "session-1",
      requestId: "document-1",
    },
    {
      type: "hse:reset",
      token: "session-1",
    },
  ])("accepts the $type command", (message) => {
    expect(ParentToFrameMessageSchema.parse(message).type).toBe(message.type);
  });

  it("rejects commands without the session token", () => {
    expect(() =>
      ParentToFrameMessageSchema.parse({
        type: "hse:request-document",
        requestId: "document-1",
      }),
    ).toThrow();
  });

  it("rejects commands with an empty session token", () => {
    expect(() =>
      ParentToFrameMessageSchema.parse({
        type: "hse:request-document",
        token: "",
        requestId: "document-1",
      }),
    ).toThrow();
  });

  it("requires a request ID on document requests", () => {
    expect(() =>
      ParentToFrameMessageSchema.parse({
        type: "hse:request-document",
        token: "session-1",
      }),
    ).toThrow();
  });

  it.each([
    {
      type: "hse:apply-patch",
      token: "session-1",
      requestId: "mutation-1",
      commandId: "patch-1",
      label: "Move object",
      targetId: "node-1",
      patch: { translateX: 20, width: 400, height: "auto" },
    },
    {
      type: "hse:duplicate-object",
      token: "session-1",
      requestId: "mutation-2",
      commandId: "duplicate-1",
      label: "Duplicate object",
      targetId: "node-1",
    },
    {
      type: "hse:apply-history",
      token: "session-1",
      requestId: "mutation-3",
      direction: "before",
      command: {
        id: "delete-1",
        label: "Delete object",
        kind: "delete-object",
        targetId: "node-1",
        before: {
          parentId: "parent-1",
          index: 1,
          html: '<p data-hse-id="node-1">Text</p>',
        },
        after: null,
      },
    },
  ])("requires requestId on the $type mutation", (message) => {
    expect(ParentToFrameMessageSchema.parse(message)).toMatchObject(message);
    const { requestId: _requestId, ...withoutRequestId } = message;
    expect(() =>
      ParentToFrameMessageSchema.parse(withoutRequestId),
    ).toThrow();
  });
});
