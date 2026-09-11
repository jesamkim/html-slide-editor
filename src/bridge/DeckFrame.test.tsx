import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeckFrame,
  DeckFrameMutationError,
  DeckFrameRequestPendingError,
  DeckFrameRequestReplacedError,
  DeckFrameRequestTimeoutError,
  type DeckFrameHandle,
} from "./DeckFrame";
import { injectBridge } from "./injectBridge";
import {
  CommandHistory,
  type SerializableEditCommand,
} from "../core/history/commandHistory";

const readyMessage = {
  type: "hse:ready" as const,
  token: "session-1",
  slideCount: 2,
};

const cleanCheckpoint = (body: string) =>
  `<!doctype html><html><head><title>Checkpoint</title></head><body><main id="stage"><section class="slide">${body}</section></main></body></html>`;

const installAcknowledgement = (
  acknowledgement: Parameters<
    NonNullable<DeckFrameHandle["requestMutation"]>
  >[1] extends (result: infer Result) => unknown
    ? Result
    : never,
) => ({
  recoverySrcDoc: injectBridge(
    acknowledgement.checkpointHtml,
    "session-1",
    { initialOverrides: acknowledgement.overrides },
  ),
});

const frameWindow = () =>
  (screen.getByTitle("편집 중인 슬라이드") as HTMLIFrameElement)
    .contentWindow!;

const dispatchFrameMessage = (
  source: MessageEventSource,
  data: unknown,
) => {
  window.dispatchEvent(new MessageEvent("message", { source, data }));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DeckFrame", () => {
  it("flushes inline editing only after the exact correlated acknowledgement", async () => {
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});

    const request = ref.current!.commitInlineEdit!();
    const requestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;
    let settled = false;
    void request.finally(() => {
      settled = true;
    });

    dispatchFrameMessage(source, {
      type: "hse:inline-text-flush",
      token: "session-1",
      requestId: "stale-inline",
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    dispatchFrameMessage(source, {
      type: "hse:inline-text-flush",
      token: "session-1",
      requestId,
    });

    await expect(request).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "hse:commit-inline-edit",
        token: "session-1",
        requestId,
      },
      "*",
    );
  });

  it("resolves only the mutation ACK with the exact request id", async () => {
    const ref = createRef<DeckFrameHandle>();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});

    const request = ref.current!.requestMutation!(
      {
        type: "hse:apply-patch",
        commandId: "patch-1",
        label: "Move object",
        targetId: "node-1",
        patch: { translateX: 20 },
      },
      installAcknowledgement,
    );
    const requestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;

    dispatchFrameMessage(source, {
      type: "hse:mutation-ack",
      token: "session-1",
      requestId: "stale-request",
      status: "success",
      result: {
        command: {
          id: "stale",
          label: "Stale",
          kind: "patch",
          targetId: "node-1",
          before: {},
          after: {},
        },
        overrides: {},
        checkpointHtml: cleanCheckpoint("stale"),
        slideCount: 2,
        activeSlideIndex: 0,
        selection: null,
      },
    });
    let settled = false;
    void request.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    dispatchFrameMessage(source, {
      type: "hse:mutation-ack",
      token: "session-1",
      requestId,
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
        checkpointHtml: cleanCheckpoint("acknowledged"),
        slideCount: 2,
        activeSlideIndex: 0,
        selection: null,
      },
    });

    await expect(request).resolves.toMatchObject({
      command: { id: "patch-1", after: { translateX: 20 } },
    });
  });

  it("rejects a correlated mutation error ACK", async () => {
    const ref = createRef<DeckFrameHandle>();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});
    const request = ref.current!.requestMutation!(
      {
        type: "hse:delete-object",
        commandId: "delete-1",
        label: "Delete object",
        targetId: "missing",
      },
      installAcknowledgement,
    );
    const requestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;

    dispatchFrameMessage(source, {
      type: "hse:mutation-ack",
      token: "session-1",
      requestId,
      status: "error",
      error: {
        code: "TARGET_NOT_FOUND",
        message: "편집 대상을 찾을 수 없습니다.",
      },
    });

    await expect(request).rejects.toEqual(
      expect.objectContaining({
        name: "DeckFrameMutationError",
        code: "TARGET_NOT_FOUND",
      }),
    );
    await expect(request).rejects.toBeInstanceOf(DeckFrameMutationError);
  });

  it("times out and cleans up an unanswered mutation request", async () => {
    vi.useFakeTimers();
    const ref = createRef<DeckFrameHandle>();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        requestTimeoutMs={50}
        mutationRetryCount={0}
        onMessage={vi.fn()}
      />,
    );
    vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});

    const first = ref.current!.requestMutation!(
      {
        type: "hse:delete-object",
        commandId: "delete-1",
        label: "Delete object",
        targetId: "node-1",
      },
      installAcknowledgement,
    );
    const firstRejected = expect(first).rejects.toBeInstanceOf(
      DeckFrameRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(51);
    await firstRejected;

    const second = ref.current!.requestMutation!(
      {
        type: "hse:delete-object",
        commandId: "delete-2",
        label: "Delete object",
        targetId: "node-2",
      },
      installAcknowledgement,
    );
    const secondRejected = expect(second).rejects.toBeInstanceOf(
      DeckFrameRequestReplacedError,
    );
    rendered.unmount();
    await secondRejected;
  });

  it("retries a mutation with the same request id after the first ACK is lost", async () => {
    vi.useFakeTimers();
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html><body>working</body></html>"
        recoverySrcDoc="<!doctype html><html><body>acknowledged</body></html>"
        token="session-1"
        requestTimeoutMs={50}
        mutationRetryCount={1}
        onMessage={vi.fn()}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});

    const request = ref.current!.requestMutation!(
      {
        type: "hse:apply-patch",
        commandId: "patch-1",
        label: "Move object",
        targetId: "node-1",
        patch: { translateX: 20 },
      },
      installAcknowledgement,
    );
    const firstMessage = postMessage.mock.calls[0][0] as {
      requestId: string;
    };

    await vi.advanceTimersByTimeAsync(51);

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0]).toMatchObject({
      requestId: firstMessage.requestId,
      commandId: "patch-1",
    });

    dispatchFrameMessage(source, {
      type: "hse:mutation-ack",
      token: "session-1",
      requestId: firstMessage.requestId,
      status: "success",
      result: {
        command: commandAck(),
        overrides: { "node-1": { translate: "20px 0px" } },
        checkpointHtml: cleanCheckpoint("acknowledged"),
        slideCount: 2,
        activeSlideIndex: 0,
        selection: null,
      },
    });

    await expect(request).resolves.toMatchObject({
      command: { id: "patch-1" },
    });
  });

  it("remounts the last acknowledged document before rejecting after every ACK is lost", async () => {
    vi.useFakeTimers();
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html><body>possibly-mutated</body></html>"
        recoverySrcDoc="<!doctype html><html><body>last-acknowledged</body></html>"
        token="session-1"
        requestTimeoutMs={50}
        mutationRetryCount={1}
        onMessage={vi.fn()}
      />,
    );
    const originalFrame = screen.getByTitle("편집 중인 슬라이드");
    vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});

    const request = ref.current!.requestMutation!(
      {
        type: "hse:delete-object",
        commandId: "delete-1",
        label: "Delete object",
        targetId: "node-1",
      },
      installAcknowledgement,
    );
    const rejection = request.catch((error) => error);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(102);
    });

    const recoveredFrame = screen.getByTitle(
      "편집 중인 슬라이드",
    ) as HTMLIFrameElement;
    expect(recoveredFrame).not.toBe(originalFrame);
    expect(recoveredFrame.srcdoc).toContain("last-acknowledged");
    await expect(rejection).resolves.toBeInstanceOf(
      DeckFrameRequestTimeoutError,
    );
  });

  it("preserves command A in the installed checkpoint and history when command B applies but every ACK is lost", async () => {
    vi.useFakeTimers();
    const ref = createRef<DeckFrameHandle>();
    const initialCheckpoint = cleanCheckpoint("initial");
    render(
      <DeckFrame
        ref={ref}
        srcDoc={injectBridge(initialCheckpoint, "session-1")}
        recoverySrcDoc={injectBridge(initialCheckpoint, "session-1")}
        token="session-1"
        requestTimeoutMs={50}
        mutationRetryCount={1}
        onMessage={vi.fn()}
      />,
    );
    const originalFrame = screen.getByTitle(
      "편집 중인 슬라이드",
    ) as HTMLIFrameElement;
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});
    const requestDocument = vi.spyOn(ref.current!, "requestDocument");
    const commandA: SerializableEditCommand = {
      id: "command-a",
      label: "Command A",
      kind: "patch",
      targetId: "node-1",
      before: { text: "initial" },
      after: { text: "A" },
    };
    const commandB: SerializableEditCommand = {
      ...commandA,
      id: "command-b",
      label: "Command B",
      before: { text: "A" },
      after: { text: "B" },
    };
    const installedCheckpoint = cleanCheckpoint("A");
    const history = new CommandHistory({
      apply: async (command) => {
        const result = await ref.current!.requestMutation!(
          {
            type: "hse:apply-patch",
            commandId: command.id,
            label: command.label,
            targetId: command.targetId,
            patch: command.after as { text: string },
          },
          (acknowledgement) => ({
            recoverySrcDoc: injectBridge(
              acknowledgement.checkpointHtml,
              "session-1",
              { initialOverrides: acknowledgement.overrides },
            ),
          }),
        );
        return result.command;
      },
    });

    const firstExecute = history.execute(commandA);
    await Promise.resolve();
    const firstRequestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;
    dispatchFrameMessage(source, {
      type: "hse:mutation-ack",
      token: "session-1",
      requestId: firstRequestId,
      status: "success",
      result: {
        command: commandA,
        overrides: {},
        checkpointHtml: installedCheckpoint,
        slideCount: 1,
        activeSlideIndex: 0,
        selection: null,
      },
    });
    await firstExecute;
    expect(history.snapshot().commands).toEqual([commandA]);
    expect(requestDocument).not.toHaveBeenCalled();

    const secondExecute = history.execute(commandB);
    const secondRejected = expect(secondExecute).rejects.toBeInstanceOf(
      DeckFrameRequestTimeoutError,
    );
    await Promise.resolve();
    originalFrame.srcdoc = injectBridge(cleanCheckpoint("B"), "session-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(102);
    });

    const recoveredFrame = screen.getByTitle(
      "편집 중인 슬라이드",
    ) as HTMLIFrameElement;
    expect(recoveredFrame).not.toBe(originalFrame);
    expect(recoveredFrame.srcdoc).toContain(">A<");
    expect(recoveredFrame.srcdoc).not.toContain(">B<");
    await secondRejected;
    expect(history.snapshot()).toMatchObject({
      commands: [commandA],
      size: 1,
      cursor: 1,
    });
  });

  it("rejects a correlated success ACK whose checkpoint installer rejects and remounts the prior checkpoint", async () => {
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc={injectBridge(cleanCheckpoint("working"), "session-1")}
        recoverySrcDoc={injectBridge(
          cleanCheckpoint("last-installed"),
          "session-1",
        )}
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    const originalFrame = screen.getByTitle("편집 중인 슬라이드");
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});
    const request = ref.current!.requestMutation!(
      {
        type: "hse:apply-patch",
        commandId: "forged",
        label: "Forged checkpoint",
        targetId: "node-1",
        patch: { text: "forged" },
      },
      () => {
        throw new Error("invalid mutation checkpoint");
      },
    );
    const rejection = request.catch((error) => error);
    const requestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;

    dispatchFrameMessage(source, {
      type: "hse:mutation-ack",
      token: "session-1",
      requestId,
      status: "success",
      result: {
        command: {
          id: "forged",
          label: "Forged checkpoint",
          kind: "patch",
          targetId: "node-1",
          before: { text: "working" },
          after: { text: "forged" },
        },
        overrides: {},
        checkpointHtml: cleanCheckpoint(
          '<script data-hse-editor-bridge></script>',
        ),
        slideCount: 1,
        activeSlideIndex: 0,
        selection: null,
      },
    });

    await act(async () => {
      await Promise.resolve();
    });

    const recoveredFrame = screen.getByTitle(
      "편집 중인 슬라이드",
    ) as HTMLIFrameElement;
    expect(recoveredFrame).not.toBe(originalFrame);
    expect(recoveredFrame.srcdoc).toContain("last-installed");
    await expect(rejection).resolves.toEqual(
      expect.objectContaining({ message: "invalid mutation checkpoint" }),
    );
  });

  it("rejects pending mutation requests when the frame is replaced", async () => {
    const ref = createRef<DeckFrameHandle>();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});
    const request = ref.current!.requestMutation!(
      {
        type: "hse:delete-object",
        commandId: "delete-1",
        label: "Delete object",
        targetId: "node-1",
      },
      installAcknowledgement,
    );
    const rejected = expect(request).rejects.toBeInstanceOf(
      DeckFrameRequestReplacedError,
    );

    rendered.rerender(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html><body>replacement</body></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );

    await rejected;
  });

  it("accepts only schema-valid messages from the exact iframe and token", () => {
    const onMessage = vi.fn();
    render(
      <DeckFrame
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={onMessage}
      />,
    );
    const source = frameWindow();

    expect(() => {
      dispatchFrameMessage(window, readyMessage);
      dispatchFrameMessage(source, { ...readyMessage, token: "session-2" });
      dispatchFrameMessage(source, {
        ...readyMessage,
        unexpected: true,
      });
      dispatchFrameMessage(source, {
        ...readyMessage,
        slideCount: "2",
      });
    }).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();

    dispatchFrameMessage(source, readyMessage);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(readyMessage);
  });

  it("adds the current token after the caller payload", () => {
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    const postMessage = vi
      .spyOn(frameWindow(), "postMessage")
      .mockImplementation(() => {});

    act(() => {
      ref.current!.send({
        type: "hse:request-document",
        requestId: "caller-request",
        token: "caller-token",
      } as never);
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "hse:request-document",
        token: "session-1",
        requestId: "caller-request",
      },
      "*",
    );
  });

  it("rejects an overlapping document request and resolves the original", async () => {
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});

    const first = ref.current!.requestDocument();
    const overlapping = ref.current!.requestDocument();
    const requestId = (
      postMessage.mock.calls[0][0] as {
        requestId: string;
      }
    ).requestId;

    await expect(overlapping).rejects.toBeInstanceOf(
      DeckFrameRequestPendingError,
    );
    expect(postMessage).toHaveBeenCalledTimes(1);

    dispatchFrameMessage(source, {
      type: "hse:document",
      token: "session-1",
      requestId,
      html: "<!doctype html><html><body>current</body></html>",
    });

    await expect(first).resolves.toContain("current");
  });

  it("reports an uncorrelated runtime error without rejecting a pending document request", async () => {
    const ref = createRef<DeckFrameHandle>();
    const onMessage = vi.fn();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={onMessage}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});

    const request = ref.current!.requestDocument();
    const requestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;

    dispatchFrameMessage(source, {
      type: "hse:error",
      token: "session-1",
      kind: "error",
      message: "deck runtime failed",
      slideIndex: 0,
    });
    await Promise.resolve();

    dispatchFrameMessage(source, {
      type: "hse:document",
      token: "session-1",
      requestId,
      html: "<!doctype html><html><body>current</body></html>",
    });

    await expect(request).resolves.toContain("current");
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hse:error",
        message: "deck runtime failed",
      }),
    );
  });

  it("times out an unanswered document request", async () => {
    vi.useFakeTimers();
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        requestTimeoutMs={50}
        onMessage={vi.fn()}
      />,
    );
    vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});

    const request = ref.current!.requestDocument();
    const rejected = expect(request).rejects.toBeInstanceOf(
      DeckFrameRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(51);

    await rejected;
  });

  it("ignores a late timed-out response after a newer request starts", async () => {
    vi.useFakeTimers();
    const ref = createRef<DeckFrameHandle>();
    render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        requestTimeoutMs={50}
        onMessage={vi.fn()}
      />,
    );
    const source = frameWindow();
    const postMessage = vi
      .spyOn(source, "postMessage")
      .mockImplementation(() => {});

    const first = ref.current!.requestDocument();
    const firstRequestId = (
      postMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;
    const firstRejected = expect(first).rejects.toBeInstanceOf(
      DeckFrameRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(51);
    await firstRejected;

    const second = ref.current!.requestDocument();
    const secondRequestId = (
      postMessage.mock.calls[1][0] as { requestId: string }
    ).requestId;
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    dispatchFrameMessage(source, {
      type: "hse:document",
      token: "session-1",
      requestId: firstRequestId,
      html: "<!doctype html><html><body>stale</body></html>",
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    dispatchFrameMessage(source, {
      type: "hse:document",
      token: "session-1",
      requestId: secondRequestId,
      html: "<!doctype html><html><body>fresh</body></html>",
    });
    await expect(second).resolves.toContain("fresh");
  });

  it("replaces the iframe identity and ignores stale same-token srcDoc responses", async () => {
    const ref = createRef<DeckFrameHandle>();
    const onMessage = vi.fn();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html><body>first</body></html>"
        token="session-1"
        onMessage={onMessage}
      />,
    );
    const oldSource = frameWindow();
    const oldPostMessage = vi
      .spyOn(oldSource, "postMessage")
      .mockImplementation(() => {});
    const oldRequest = ref.current!.requestDocument();
    const oldRequestId = (
      oldPostMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;
    const oldRejected = expect(oldRequest).rejects.toBeInstanceOf(
      DeckFrameRequestReplacedError,
    );

    rendered.rerender(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html><body>second</body></html>"
        token="session-1"
        onMessage={onMessage}
      />,
    );
    await oldRejected;

    const newSource = frameWindow();
    expect(newSource === oldSource).toBe(false);
    const newPostMessage = vi
      .spyOn(newSource, "postMessage")
      .mockImplementation(() => {});
    const currentRequest = ref.current!.requestDocument();
    const currentRequestId = (
      newPostMessage.mock.calls[0][0] as { requestId: string }
    ).requestId;
    let currentSettled = false;
    void currentRequest.then(
      () => {
        currentSettled = true;
      },
      () => {
        currentSettled = true;
      },
    );

    dispatchFrameMessage(oldSource, {
      type: "hse:document",
      token: "session-1",
      requestId: oldRequestId,
      html: "<!doctype html><html><body>old source</body></html>",
    });
    dispatchFrameMessage(newSource, {
      type: "hse:document",
      token: "session-1",
      requestId: oldRequestId,
      html: "<!doctype html><html><body>old request</body></html>",
    });
    await Promise.resolve();

    expect(currentSettled).toBe(false);
    expect(onMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "hse:document" }),
    );

    dispatchFrameMessage(newSource, {
      type: "hse:document",
      token: "session-1",
      requestId: currentRequestId,
      html: "<!doctype html><html><body>current</body></html>",
    });
    await expect(currentRequest).resolves.toContain("current");
  });

  it("rejects a pending request when unmounted", async () => {
    const ref = createRef<DeckFrameHandle>();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});

    const request = ref.current!.requestDocument();
    const rejected = expect(request).rejects.toBeInstanceOf(
      DeckFrameRequestReplacedError,
    );
    rendered.unmount();

    await rejected;
  });

  it.each([
    {
      label: "token",
      next: { token: "session-2", srcDoc: "<!doctype html><html></html>" },
    },
    {
      label: "srcDoc",
      next: {
        token: "session-1",
        srcDoc: "<!doctype html><html><body>replacement</body></html>",
      },
    },
  ])("rejects a pending request when $label changes", async ({ next }) => {
    const ref = createRef<DeckFrameHandle>();
    const rendered = render(
      <DeckFrame
        ref={ref}
        srcDoc="<!doctype html><html></html>"
        token="session-1"
        onMessage={vi.fn()}
      />,
    );
    vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});

    const request = ref.current!.requestDocument();
    const rejected = expect(request).rejects.toBeInstanceOf(
      DeckFrameRequestReplacedError,
    );
    rendered.rerender(
      <DeckFrame
        ref={ref}
        srcDoc={next.srcDoc}
        token={next.token}
        onMessage={vi.fn()}
      />,
    );

    await rejected;
  });
});

const commandAck = () => ({
  id: "patch-1",
  label: "Move object",
  kind: "patch" as const,
  targetId: "node-1",
  before: { override: null },
  after: { override: { translate: "20px 0px" } },
});
