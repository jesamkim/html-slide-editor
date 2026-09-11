// @ts-expect-error jsdom has no declaration package in this project.
import { JSDOM } from "jsdom";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DeckFrameRequestPendingError,
  DeckFrameRequestTimeoutError,
  type DeckFrameHandle,
} from "../../bridge/DeckFrame";
import { injectBridge } from "../../bridge/injectBridge";
import type { MutationSuccess } from "../../bridge/protocol";
import type { SerializableEditCommand } from "../../core/history/commandHistory";
import type { RecoveryRecord } from "../../core/persistence/sessionStore";
import {
  INVALID_MISSING_STAGE,
  VALID_MINIMAL_DECK,
} from "../../test/minimalDeck";
import {
  fingerprintHtml,
  useDeckSession,
} from "./useDeckSession";

const file = (
  name: string,
  read: () => Promise<string>,
): File =>
  ({
    name,
    text: read,
  }) as File;

const immediateFile = (name: string, html: string) =>
  file(name, async () => html);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const command = (): SerializableEditCommand => ({
  id: "move-1",
  label: "Move object",
  kind: "patch",
  targetId: "node-1",
  before: { translateX: 0 },
  after: { translateX: 20 },
});

type MutationResult = MutationSuccess["result"];
type MutationPayload = Parameters<
  NonNullable<DeckFrameHandle["requestMutation"]>
>[0];
type MutationInstaller = Parameters<
  NonNullable<DeckFrameHandle["requestMutation"]>
>[1];

const mutationResult = (
  result: Omit<
    MutationResult,
    "checkpointHtml" | "selection" | "command"
  > & {
    command: SerializableEditCommand;
    checkpointHtml?: string;
    selection?: MutationResult["selection"];
  },
): MutationResult =>
  ({
    checkpointHtml: VALID_MINIMAL_DECK,
    selection: null,
    ...result,
  }) as MutationResult;

const acknowledgeMutation =
  (
    result:
      | MutationResult
      | ((payload: MutationPayload) => MutationResult),
  ) =>
  async (payload: MutationPayload, installCheckpoint: MutationInstaller) => {
    const acknowledgement =
      typeof result === "function" ? result(payload) : result;
    installCheckpoint(acknowledgement);
    return acknowledgement;
  };

const recoveryRecord = (
  overrides: Partial<RecoveryRecord> = {},
): RecoveryRecord => ({
  id: "recovery-1",
  fileName: "recovered.html",
  fingerprint: "saved-fingerprint",
  baselineIdCounts: { intro: 1 },
  html: VALID_MINIMAL_DECK,
  activeSlide: 2,
  overrides: {},
  commands: [command()],
  historyCursor: 1,
  exportedAt: null,
  updatedAt: 100,
  ...overrides,
});

const recoveryStore = (
  recovery: RecoveryRecord | null = null,
  corruptIds: IDBValidKey[] = [],
) => ({
  loadLatestRecoveryWithDiagnostics: vi.fn().mockResolvedValue({
    recovery,
    corruptIds,
  }),
  saveRecovery: vi.fn().mockResolvedValue(undefined),
  markExported: vi.fn().mockResolvedValue(true),
  deleteRecovery: vi.fn().mockResolvedValue(undefined),
});

let blobSequence = 0;
let createdBlobs: Blob[] = [];

beforeEach(() => {
  blobSequence = 0;
  createdBlobs = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (blob) => {
      createdBlobs.push(blob as Blob);
      return `blob:preview-${++blobSequence}`;
    },
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fingerprintHtml", () => {
  it("returns the deterministic SHA-256 digest of the exact source text", async () => {
    await expect(fingerprintHtml("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(fingerprintHtml("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("useDeckSession", () => {
  it.each([
    ["ArrowRight", false, { translateX: 6, translateY: 7 }],
    ["ArrowUp", true, { translateX: 5, translateY: -3 }],
  ] as const)(
    "turns %s into one acknowledged keyboard movement command",
    async (key, shiftKey, expectedPatch) => {
      const requestMutation = vi.fn(
        acknowledgeMutation((payload) =>
          mutationResult({
            command: {
              id: "commandId" in payload ? payload.commandId : payload.command.id,
              label: "Move object",
              kind: "patch" as const,
              targetId: "node-1",
              before: { override: { translate: "5px 7px" } },
              after: {
                override: {
                  translate: `${expectedPatch.translateX}px ${expectedPatch.translateY}px`,
                },
              },
            },
            overrides: {
              "node-1": {
                translate: `${expectedPatch.translateX}px ${expectedPatch.translateY}px`,
              },
            },
            slideCount: 2,
            activeSlideIndex: 0,
          }),
        ),
      );
      const frame: DeckFrameHandle = {
        send: vi.fn(),
        requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
        requestMutation,
      };
      const { result } = renderHook(() => useDeckSession());
      await act(async () => {
        await result.current.openFile(
          immediateFile("deck.html", VALID_MINIMAL_DECK),
        );
      });
      const token = result.current.state.session!.token;
      act(() => {
        result.current.frameRef.current = frame;
        result.current.handleFrameMessage({
          type: "hse:selection",
          token,
          targetId: "node-1",
          path: ["section.slide", "h1"],
          bounds: { x: 100, y: 100, width: 300, height: 80 },
          kind: "text",
          transform: { translateX: 5, translateY: 7 },
          text: "Introduction",
          styles: null,
        });
        result.current.handleFrameMessage({
          type: "hse:editor-key",
          token,
          key,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey,
        });
      });

      await waitFor(() => {
        expect(requestMutation).toHaveBeenCalledOnce();
      });
      expect(requestMutation).toHaveBeenCalledWith(
        {
          type: "hse:apply-patch",
          commandId: expect.any(String),
          label: "Move object",
          targetId: "node-1",
          patch: expectedPatch,
        },
        expect.any(Function),
      );
      await waitFor(() => {
        expect(result.current.history.size).toBe(1);
      });
    },
  );

  it("records only the acknowledged mutation and refreshes overrides and preview", async () => {
    const acknowledged: MutationSuccess["result"]["command"] = {
      id: "move-1",
      label: "Move object",
      kind: "patch",
      targetId: "node-1",
      before: { override: null },
      after: { override: { translate: "20px 0px" } },
    };
    const acknowledgedSelection = {
      targetId: "node-1",
      path: ["section.slide", "h1"],
      bounds: { x: 30, y: 40, width: 300, height: 60 },
      kind: "text" as const,
      transform: { translateX: 20, translateY: 0 },
      text: "Introduction",
      styles: null,
    };
    const checkpointHtml = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Introduction</h1>',
    );
    const requestMutation = vi.fn().mockImplementation(
      async (
        _payload,
        installCheckpoint: (
          mutation: MutationSuccess["result"],
        ) => { recoverySrcDoc: string },
      ) => {
        const mutation = {
          command: acknowledged,
          overrides: {
            "node-1": { translate: "20px 0px" },
          },
          checkpointHtml,
          slideCount: 2,
          activeSlideIndex: 1,
          selection: acknowledgedSelection,
        };
        installCheckpoint(mutation);
        return mutation;
      },
    );
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi
        .fn()
        .mockRejectedValue(new Error("post-ACK sync must not run")),
      requestMutation,
    };
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let dispatchResult!: Awaited<
      ReturnType<typeof result.current.sendCommand>
    >;
    await act(async () => {
      dispatchResult = await result.current.sendCommand(command());
    });

    expect(dispatchResult).toEqual({
      status: "committed",
      command: acknowledged,
    });
    expect(requestMutation).toHaveBeenCalledWith(
      {
        type: "hse:apply-patch",
        commandId: "move-1",
        label: "Move object",
        targetId: "node-1",
        patch: { translateX: 20 },
      },
      expect.any(Function),
    );
    expect(frame.requestDocument).not.toHaveBeenCalled();
    expect(result.current.history.commands).toEqual([acknowledged]);
    expect(result.current.state.session).toMatchObject({
      workingHtml: checkpointHtml,
      overrides: {
        "node-1": { translate: "20px 0px" },
      },
      activeSlide: 2,
      slideCount: 2,
      previewUrl: "blob:preview-1",
      dirty: true,
    });
    expect(result.current.state.selection).toEqual(acknowledgedSelection);
    expect(result.current.state.session?.workingHtml).not.toContain(
      "hse-overrides",
    );
    expect(await createdBlobs[0].text()).toContain(
      'data-hse-id="node-1"',
    );
    expect(await createdBlobs[0].text()).toContain(
      "translate: 20px 0px",
    );
  });

  it.each([
    {
      label: "forged bridge artifact",
      checkpointHtml: VALID_MINIMAL_DECK.replace(
        "</head>",
        '<script data-hse-editor-bridge></script></head>',
      ),
      slideCount: 2,
      error: "편집기 브리지 마커가 남아 있습니다.",
    },
    {
      label: "stale slide count",
      checkpointHtml: VALID_MINIMAL_DECK,
      slideCount: 1,
      error: "슬라이드 수가 일치하지 않습니다. 예상 1개, 실제 2개입니다.",
    },
  ])(
    "rejects a $label checkpoint before history records success",
    async ({ checkpointHtml, slideCount, error }) => {
      const acknowledgement = mutationResult({
        command: command(),
        overrides: { "node-1": { translate: "20px 0px" } },
        checkpointHtml,
        slideCount,
        activeSlideIndex: 0,
      });
      const frame: DeckFrameHandle = {
        send: vi.fn(),
        requestDocument: vi.fn(),
        requestMutation: vi.fn(
          acknowledgeMutation(acknowledgement),
        ),
      };
      const { result } = renderHook(() => useDeckSession());
      await act(async () => {
        await result.current.openFile(
          immediateFile("deck.html", VALID_MINIMAL_DECK),
        );
        result.current.frameRef.current = frame;
      });

      await act(async () => {
        await expect(result.current.sendCommand(command())).rejects.toThrow(
          error,
        );
      });

      expect(result.current.history).toMatchObject({
        commands: [],
        size: 0,
        cursor: 0,
      });
      expect(result.current.state.session).toMatchObject({
        workingHtml: VALID_MINIMAL_DECK,
        overrides: {},
        dirty: false,
      });
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );

  it("uses an acknowledged history request for undo", async () => {
    const requestMutation = vi
      .fn()
      .mockImplementationOnce(
        acknowledgeMutation(mutationResult({
        command: command(),
        overrides: {
          "node-1": { translate: "20px 0px" },
        },
        slideCount: 2,
        activeSlideIndex: 0,
        })),
      )
      .mockImplementationOnce(
        acknowledgeMutation(mutationResult({
        command: command(),
        overrides: {
          "node-1": { translate: "0px 0px" },
        },
        slideCount: 2,
        activeSlideIndex: 0,
        })),
      );
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
      requestMutation,
    };
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(command());
      await result.current.undo();
    });

    expect(requestMutation).toHaveBeenLastCalledWith(
      {
        type: "hse:apply-history",
        direction: "before",
        command: command(),
      },
      expect.any(Function),
    );
    expect(result.current.history).toMatchObject({
      cursor: 0,
      canRedo: true,
    });
  });

  it("loads, fingerprints, validates, and injects a deck before replacing state", async () => {
    const { result } = renderHook(() => useDeckSession());

    let opened!: Awaited<ReturnType<typeof result.current.openFile>>;
    await act(async () => {
      opened = await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });

    expect(opened.status).toBe("opened");
    expect(result.current.state).toMatchObject({
      status: "ready",
      error: null,
      session: {
        fileName: "deck.html",
        sourceHtml: VALID_MINIMAL_DECK,
        workingHtml: VALID_MINIMAL_DECK,
        previewUrl: null,
        slideCount: 2,
        activeSlide: 1,
        dirty: false,
      },
    });
    expect(result.current.state.session?.fingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(result.current.state.session?.token).not.toBe("");
    expect(result.current.state.session?.srcDoc).toContain(
      "data-hse-editor-bridge",
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("preserves a good session when a later import fails validation", async () => {
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("good.html", VALID_MINIMAL_DECK),
      );
    });
    const current = result.current.state.session;

    let rejected!: Awaited<ReturnType<typeof result.current.openFile>>;
    await act(async () => {
      rejected = await result.current.openFile(
        immediateFile("bad.html", INVALID_MISSING_STAGE),
      );
    });

    expect(rejected).toEqual({
      status: "rejected",
      error: "#stage 요소가 없습니다.",
    });
    expect(result.current.state.session).toBe(current);
    expect(result.current.state).toMatchObject({
      status: "ready",
      error: "#stage 요소가 없습니다.",
    });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("lets the newest file.text promise win even when an older read settles later", async () => {
    const olderRead = deferred<string>();
    const newerRead = deferred<string>();
    const { result } = renderHook(() => useDeckSession());

    let olderOpen!: ReturnType<typeof result.current.openFile>;
    let newerOpen!: ReturnType<typeof result.current.openFile>;
    act(() => {
      olderOpen = result.current.openFile(
        file("older.html", () => olderRead.promise),
      );
      newerOpen = result.current.openFile(
        file("newer.html", () => newerRead.promise),
      );
    });

    newerRead.resolve(
      VALID_MINIMAL_DECK.replace("Minimal Deck", "Newest Deck"),
    );
    await act(async () => {
      await newerOpen;
    });
    const newestToken = result.current.state.session?.token;

    olderRead.resolve(
      VALID_MINIMAL_DECK.replace("Minimal Deck", "Older Deck"),
    );
    let olderResult!: Awaited<typeof olderOpen>;
    await act(async () => {
      olderResult = await olderOpen;
    });

    expect(olderResult).toEqual({ status: "superseded" });
    expect(result.current.state.session).toMatchObject({
      fileName: "newer.html",
      token: newestToken,
    });
  });

  it("requests one bridge-free document for duplicate ready messages", async () => {
    const requestDocument = vi.fn().mockResolvedValue(VALID_MINIMAL_DECK);
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument,
    };
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    const token = result.current.state.session!.token;
    act(() => {
      result.current.frameRef.current = frame;
      result.current.handleFrameMessage({
        type: "hse:ready",
        token,
        slideCount: 2,
      });
      result.current.handleFrameMessage({
        type: "hse:ready",
        token,
        slideCount: 2,
      });
    });

    await waitFor(() => {
      expect(result.current.state.session?.previewUrl).toBe(
        "blob:preview-1",
      );
    });

    expect(requestDocument).toHaveBeenCalledOnce();
    expect(result.current.state.session?.workingHtml).toBe(
      VALID_MINIMAL_DECK,
    );
    expect(
      result.current.state.session?.workingHtml,
    ).not.toContain("data-hse-editor-bridge");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "timeout",
      error: new DeckFrameRequestTimeoutError(),
    },
    {
      label: "overlap",
      error: new DeckFrameRequestPendingError(),
    },
  ])(
    "retries ready document sync after a $label failure",
    async ({ error }) => {
      const requestDocument = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(VALID_MINIMAL_DECK);
      const frame: DeckFrameHandle = {
        send: vi.fn(),
        requestDocument,
      };
      const { result } = renderHook(() => useDeckSession());
      await act(async () => {
        await result.current.openFile(
          immediateFile("deck.html", VALID_MINIMAL_DECK),
        );
      });
      const token = result.current.state.session!.token;
      act(() => {
        result.current.frameRef.current = frame;
        result.current.handleFrameMessage({
          type: "hse:ready",
          token,
          slideCount: 2,
        });
      });
      await waitFor(() => {
        expect(result.current.state.error).toBe(error.message);
      });

      act(() => {
        result.current.handleFrameMessage({
          type: "hse:ready",
          token,
          slideCount: 2,
        });
      });
      await waitFor(() => {
        expect(result.current.state.session?.previewUrl).toBe(
          "blob:preview-1",
        );
      });

      expect(requestDocument).toHaveBeenCalledTimes(2);
      expect(result.current.state.error).toBeNull();
    },
  );

  it("revokes preview URLs on successful replacement and unmount", async () => {
    const requestDocument = vi.fn().mockResolvedValue(VALID_MINIMAL_DECK);
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument,
    };
    const { result, unmount } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("first.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
      result.current.handleFrameMessage({
        type: "hse:ready",
        token: result.current.state.session!.token,
        slideCount: 2,
      });
    });
    await waitFor(() => {
      expect(result.current.state.session?.previewUrl).toBe(
        "blob:preview-1",
      );
    });

    await act(async () => {
      await result.current.openFile(
        immediateFile("second.html", VALID_MINIMAL_DECK),
      );
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    act(() => {
      result.current.handleFrameMessage({
        type: "hse:ready",
        token: result.current.state.session!.token,
        slideCount: 2,
      });
    });
    await waitFor(() => {
      expect(result.current.state.session?.previewUrl).toBe(
        "blob:preview-2",
      );
    });

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });

  it("ignores ready messages from a replaced session token", async () => {
    const requestDocument = vi.fn().mockResolvedValue(VALID_MINIMAL_DECK);
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument,
    };
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("first.html", VALID_MINIMAL_DECK),
      );
    });
    const staleToken = result.current.state.session!.token;
    await act(async () => {
      await result.current.openFile(
        immediateFile("second.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
      result.current.handleFrameMessage({
        type: "hse:ready",
        token: staleToken,
        slideCount: 99,
      });
    });

    await Promise.resolve();

    expect(requestDocument).not.toHaveBeenCalled();
    expect(result.current.state.session?.fileName).toBe("second.html");
    expect(result.current.state.session?.slideCount).toBe(2);
  });

  it("returns a typed pending result instead of recording an unacknowledged command", async () => {
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi.fn(),
    };
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let dispatchResult!: Awaited<
      ReturnType<typeof result.current.sendCommand>
    >;
    await act(async () => {
      dispatchResult = await result.current.sendCommand(command());
    });

    expect(dispatchResult).toMatchObject({
      status: "pending",
      reason: "bridge-acknowledgement-unavailable",
      command: command(),
    });
    expect(result.current.history).toMatchObject({
      size: 0,
      cursor: 0,
      canUndo: false,
      canRedo: false,
    });
    expect(frame.send).not.toHaveBeenCalled();
  });

  it("prepares and fully validates export HTML without creating a download Blob", async () => {
    const store = recoveryStore();
    const validateRuntime = vi.fn().mockResolvedValue({ ok: true });
    const requestDocument = vi.fn().mockResolvedValue(VALID_MINIMAL_DECK);
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument,
    };
    const { result } = renderHook(() =>
      useDeckSession({ recoveryStore: store, validateRuntime }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let prepared!: Awaited<ReturnType<typeof result.current.exportDeck>>;
    await act(async () => {
      prepared = await result.current.exportDeck();
    });

    expect(prepared.fileName).toBe("deck.html");
    expect(prepared.validation).toEqual({ ok: true });
    expect(prepared.html).toContain("<!DOCTYPE html>");
    expect(prepared.html).not.toContain("data-hse-editor-bridge");
    expect("blob" in prepared).toBe(false);
    expect(validateRuntime).toHaveBeenCalledWith(prepared.html);
    expect(createdBlobs).toHaveLength(0);
    expect(result.current.state.status).toBe("ready");
  });

  it("stops before runtime validation when structural export validation fails", async () => {
    const validateRuntime = vi.fn().mockResolvedValue({ ok: true });
    const oneSlide = VALID_MINIMAL_DECK.replace(
      '<section class="slide"><p>Fallback label</p></section>',
      "",
    );
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi.fn().mockResolvedValue(oneSlide),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: recoveryStore(),
        validateRuntime,
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
      result.current.frameRef.current = frame;
    });

    await act(async () => {
      await expect(result.current.exportDeck()).rejects.toThrow(
        "슬라이드 수가 일치하지 않습니다. 예상 2개, 실제 1개입니다.",
      );
    });

    expect(validateRuntime).not.toHaveBeenCalled();
    expect(createdBlobs).toHaveLength(0);
    expect(result.current.state).toMatchObject({
      status: "ready",
      error: "슬라이드 수가 일치하지 않습니다. 예상 2개, 실제 1개입니다.",
    });
  });

  it("preserves the session and exposes the exact runtime validation failure", async () => {
    const validateRuntime = vi.fn().mockResolvedValue({
      ok: false,
      code: "NAVIGATION",
      message: "슬라이드 다음 이동을 확인할 수 없습니다.",
    });
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: recoveryStore(),
        validateRuntime,
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
      result.current.frameRef.current = frame;
    });

    await act(async () => {
      await expect(result.current.exportDeck()).rejects.toThrow(
        "슬라이드 다음 이동을 확인할 수 없습니다.",
      );
    });

    expect(createdBlobs).toHaveLength(0);
    expect(result.current.state).toMatchObject({
      status: "ready",
      error: "슬라이드 다음 이동을 확인할 수 없습니다.",
      session: { fileName: "deck.html" },
    });
  });

  it("cancels a pending export after unmount without publishing a Blob", async () => {
    const documentRequest = deferred<string>();
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi.fn(() => documentRequest.promise),
    };
    const { result, unmount } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let exportPromise!: ReturnType<typeof result.current.exportDeck>;
    act(() => {
      exportPromise = result.current.exportDeck();
    });
    const rejected = expect(exportPromise).rejects.toThrow(
      "편집 세션이 취소되었습니다.",
    );
    unmount();
    documentRequest.resolve(VALID_MINIMAL_DECK);

    await rejected;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("cancels a pending export when its session token is replaced", async () => {
    const documentRequest = deferred<string>();
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestDocument: vi.fn(() => documentRequest.promise),
    };
    const { result } = renderHook(() => useDeckSession());
    await act(async () => {
      await result.current.openFile(
        immediateFile("first.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let exportPromise!: ReturnType<typeof result.current.exportDeck>;
    act(() => {
      exportPromise = result.current.exportDeck();
    });
    const rejected = expect(exportPromise).rejects.toThrow(
      "편집 세션이 취소되었습니다.",
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("second.html", VALID_MINIMAL_DECK),
      );
    });
    documentRequest.resolve(VALID_MINIMAL_DECK);

    await rejected;
    expect(result.current.state).toMatchObject({
      status: "ready",
      error: null,
      session: { fileName: "second.html" },
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("saves one bridge-free recovery record 500ms after an acknowledged command", async () => {
    vi.useFakeTimers();
    const store = recoveryStore();
    const acknowledged = command();
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestMutation: vi.fn(acknowledgeMutation(mutationResult({
        command: acknowledged,
        overrides: { "node-1": { translate: "20px 0px" } },
        slideCount: 2,
        activeSlideIndex: 1,
      }))),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
        now: () => 500,
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(command());
    });
    const token = result.current.state.session!.token;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(store.saveRecovery).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(store.saveRecovery).toHaveBeenCalledOnce();
    expect(store.saveRecovery).toHaveBeenCalledWith({
      id: token,
      fileName: "deck.html",
      fingerprint: result.current.state.session!.fingerprint,
      baselineIdCounts: { intro: 1, stage: 1 },
      html: VALID_MINIMAL_DECK,
      activeSlide: 2,
      overrides: { "node-1": { translate: "20px 0px" } },
      commands: [acknowledged],
      historyCursor: 1,
      exportedAt: null,
      updatedAt: 500,
    });
  });

  it("restarts the debounce and saves only the newest acknowledged history", async () => {
    vi.useFakeTimers();
    const store = recoveryStore();
    const first = command();
    const second = { ...command(), id: "move-2", label: "Move again" };
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestMutation: vi
        .fn()
        .mockImplementationOnce(acknowledgeMutation(mutationResult({
          command: first,
          overrides: { "node-1": { translate: "20px 0px" } },
          slideCount: 2,
          activeSlideIndex: 0,
        })))
        .mockImplementationOnce(acknowledgeMutation(mutationResult({
          command: second,
          overrides: { "node-1": { translate: "40px 0px" } },
          slideCount: 2,
          activeSlideIndex: 0,
        }))),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
        now: () => 800,
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(first);
      await vi.advanceTimersByTimeAsync(300);
      await result.current.sendCommand(second);
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(store.saveRecovery).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(store.saveRecovery).toHaveBeenCalledOnce();
    expect(store.saveRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [first, second],
        historyCursor: 2,
        overrides: { "node-1": { translate: "40px 0px" } },
        updatedAt: 800,
      }),
    );
  });

  it("ignores a stale recovery document request after the session is replaced", async () => {
    vi.useFakeTimers();
    const store = recoveryStore();
    const recoveryDocument = deferred<string>();
    const requestDocument = vi.fn(() => recoveryDocument.promise);
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestMutation: vi.fn(acknowledgeMutation(mutationResult({
        command: command(),
        overrides: {},
        slideCount: 2,
        activeSlideIndex: 0,
      }))),
      requestDocument,
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("first.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(command());
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(requestDocument).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.openFile(
        immediateFile("second.html", VALID_MINIMAL_DECK),
      );
      recoveryDocument.resolve(VALID_MINIMAL_DECK);
      await Promise.resolve();
    });

    expect(store.saveRecovery).not.toHaveBeenCalled();
  });

  it("shows recovery save failures without destroying the active session", async () => {
    vi.useFakeTimers();
    const store = recoveryStore();
    store.saveRecovery.mockRejectedValueOnce(new Error("IndexedDB write failed"));
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestMutation: vi.fn(acknowledgeMutation(mutationResult({
        command: command(),
        overrides: {},
        slideCount: 2,
        activeSlideIndex: 0,
      }))),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(command());
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.recoveryError).toBe("IndexedDB write failed");
    expect(result.current.state).toMatchObject({
      status: "ready",
      session: { fileName: "deck.html", dirty: true },
    });
  });

  it("offers recovery without restoring until explicitly requested", async () => {
    const record = recoveryRecord({
      activeSlide: 99,
      overrides: { "node-1": { color: "red" } },
    });
    const store = recoveryStore(record);
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );

    await waitFor(() => {
      expect(result.current.recovery).toEqual(record);
    });
    expect(result.current.state.session).toBeNull();

    await act(async () => {
      await result.current.restoreRecovery();
    });

    expect(result.current.recovery).toBeNull();
    expect(result.current.state).toMatchObject({
      status: "ready",
      session: {
        fileName: "recovered.html",
        fingerprint: "saved-fingerprint",
        activeSlide: 2,
        dirty: true,
        overrides: { "node-1": { color: "red" } },
        previewUrl: "blob:preview-1",
      },
    });
    expect(result.current.state.session?.token).not.toBe(record.id);
    expect(result.current.state.session?.srcDoc).toContain(
      "data-hse-editor-bridge",
    );
    expect(result.current.history).toMatchObject({
      commands: [command()],
      cursor: 1,
      canUndo: true,
    });
    expect(await createdBlobs[0].text()).toContain(
      'data-hse-editor-overrides',
    );
  });

  it("restores a fake-timer recovery snapshot without uncommitted inline DOM or history drift", async () => {
    vi.useFakeTimers();
    const store = recoveryStore();
    const stableHtml = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Introduction</h1>',
    );
    const first = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await first.result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    const token = first.result.current.state.session!.token;
    const dom = new JSDOM(injectBridge(stableHtml, token), {
      runScripts: "outside-only",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(structuredClone(message));
    }) as typeof dom.window.postMessage;
    const heading = dom.window.document.querySelector<HTMLElement>("h1")!;
    heading.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 300,
      height: 60,
      top: 20,
      right: 310,
      bottom: 80,
      left: 10,
      toJSON: () => ({}),
    });
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    let documentSequence = 0;
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      requestMutation: vi.fn(acknowledgeMutation(mutationResult({
        command: command(),
        overrides: { "node-1": { translate: "20px 0px" } },
        slideCount: 2,
        activeSlideIndex: 0,
      }))),
      requestDocument: vi.fn(async () => {
        const requestId = `recovery-${++documentSequence}`;
        const messageOffset = sent.length;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: dom.window,
            data: {
              type: "hse:request-document",
              token,
              requestId,
            },
          }),
        );
        const response = sent
          .slice(messageOffset)
          .find(
            (message) =>
              message.type === "hse:document" &&
              message.requestId === requestId,
          ) as { html: string } | undefined;
        if (!response) throw new Error("bridge did not serialize recovery");
        return response.html;
      }),
    };
    await act(async () => {
      first.result.current.frameRef.current = frame;
      await first.result.current.sendCommand(command());
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
      heading.textContent = "Uncommitted";
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(store.saveRecovery).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(store.saveRecovery).toHaveBeenCalledOnce();
    const saved = store.saveRecovery.mock.calls[0][0];
    expect(saved.html).toContain("Introduction");
    expect(saved.html).not.toContain("Uncommitted");
    expect(saved.commands).toHaveLength(1);
    expect(saved.historyCursor).toBe(1);
    first.unmount();

    vi.useRealTimers();
    const restoredStore = recoveryStore(saved);
    const restored = renderHook(() =>
      useDeckSession({
        recoveryStore: restoredStore,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await waitFor(() => {
      expect(restored.result.current.recovery).toEqual(saved);
    });
    await act(async () => {
      await restored.result.current.restoreRecovery();
    });
    expect(restored.result.current.state.session?.workingHtml).toContain(
      "Introduction",
    );
    expect(restored.result.current.history).toMatchObject({
      size: 1,
      cursor: 1,
      canUndo: true,
    });
  });

  it("keeps the imported duplicate-id baseline immutable across recovery", async () => {
    const increasedHtml = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 id="intro">Introduction</h1>',
    );
    const record = recoveryRecord({
      html: increasedHtml,
      baselineIdCounts: { intro: 1 },
      commands: [],
      historyCursor: 0,
    });
    const store = recoveryStore(record);
    const validateRuntime = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() =>
      useDeckSession({ recoveryStore: store, validateRuntime }),
    );
    await waitFor(() => {
      expect(result.current.recovery).toEqual(record);
    });
    await act(async () => {
      await result.current.restoreRecovery();
    });
    act(() => {
      result.current.frameRef.current = {
        send: vi.fn(),
        commitInlineEdit: vi.fn().mockResolvedValue(undefined),
        requestDocument: vi.fn().mockResolvedValue(increasedHtml),
      };
    });

    await act(async () => {
      await expect(result.current.exportDeck()).rejects.toThrow(
        "중복 HTML id가 증가했습니다: intro (1 -> 2)",
      );
    });
    expect(validateRuntime).not.toHaveBeenCalled();
    expect(result.current.state.session?.baselineIdCounts).toEqual({
      intro: 1,
    });
  });

  it("deletes only the explicitly discarded recovery record", async () => {
    const record = recoveryRecord();
    const store = recoveryStore(record, ["corrupt-other"]);
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await waitFor(() => {
      expect(result.current.recovery).toEqual(record);
    });

    await act(async () => {
      await result.current.discardRecovery();
    });

    expect(store.deleteRecovery).toHaveBeenCalledOnce();
    expect(store.deleteRecovery).toHaveBeenCalledWith(record.id);
    expect(store.deleteRecovery).not.toHaveBeenCalledWith("corrupt-other");
    expect(result.current.recovery).toBeNull();
  });

  it("marks the restored recovery as exported without deleting it", async () => {
    const record = recoveryRecord();
    const store = recoveryStore(record);
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
        now: () => 900,
      }),
    );
    await waitFor(() => {
      expect(result.current.recovery).toEqual(record);
    });
    await act(async () => {
      await result.current.restoreRecovery();
      await result.current.markRecoveryExported();
    });

    expect(store.markExported).toHaveBeenCalledWith(record.id, 900);
    expect(store.deleteRecovery).not.toHaveBeenCalled();
  });

  it("waits for an acknowledged mutation before capturing one export snapshot", async () => {
    const mutation = deferred<Awaited<
      ReturnType<NonNullable<DeckFrameHandle["requestMutation"]>>
    >>();
    const store = recoveryStore();
    const acknowledged: MutationSuccess["result"]["command"] = {
      id: "move-1",
      label: "Move object",
      kind: "patch",
      targetId: "node-1",
      before: { override: null },
      after: { override: { color: "red" } },
    };
    const editedHtml = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Introduction</h1>',
    );
    const requestDocument = vi.fn().mockResolvedValue(editedHtml);
    let installCheckpoint!: MutationInstaller;
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn().mockResolvedValue(undefined),
      requestDocument,
      requestMutation: vi.fn((_payload, install) => {
        installCheckpoint = install;
        return mutation.promise.then((acknowledgement) => {
          installCheckpoint(acknowledgement);
          return acknowledgement;
        });
      }),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let commandPromise!: ReturnType<typeof result.current.sendCommand>;
    let exportPromise!: ReturnType<typeof result.current.exportDeck>;
    act(() => {
      commandPromise = result.current.sendCommand(command());
      exportPromise = result.current.exportDeck();
    });
    await Promise.resolve();

    expect(requestDocument).not.toHaveBeenCalled();

    mutation.resolve(mutationResult({
      command: acknowledged,
      overrides: { "node-1": { color: "red" } },
      checkpointHtml: editedHtml,
      slideCount: 2,
      activeSlideIndex: 0,
    }));

    let prepared!: Awaited<typeof exportPromise>;
    await act(async () => {
      await commandPromise;
      prepared = await exportPromise;
    });

    expect(prepared.html).toContain("color: red");
    expect(store.saveRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        html: editedHtml,
        overrides: { "node-1": { color: "red" } },
        commands: [acknowledged],
        historyCursor: 1,
      }),
    );
  });

  it("flushes and acknowledges active inline text before export capture", async () => {
    const order: string[] = [];
    const store = recoveryStore();
    const updatedHtml = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Committed inline</h1>',
    );
    let emitInlineCommit!: () => void;
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn(async () => {
        order.push("flush");
        emitInlineCommit();
      }),
      requestMutation: vi.fn(async (_payload, installCheckpoint) => {
        order.push("mutation");
        const acknowledgement = mutationResult({
          command: {
            id: "inline-command",
            label: "Edit text",
            kind: "patch" as const,
            targetId: "node-1",
            before: { text: "Introduction" },
            after: { text: "Committed inline" },
          },
          overrides: {},
          checkpointHtml: updatedHtml,
          slideCount: 2,
          activeSlideIndex: 0,
        });
        installCheckpoint(acknowledgement);
        return acknowledgement;
      }),
      requestDocument: vi.fn(async () => {
        order.push("document");
        return updatedHtml;
      }),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    const token = result.current.state.session!.token;
    emitInlineCommit = () => {
      result.current.handleFrameMessage({
        type: "hse:inline-text-commit",
        token,
        targetId: "node-1",
        before: "Introduction",
        after: "Committed inline",
      });
    };
    act(() => {
      result.current.frameRef.current = frame;
    });

    let prepared!: Awaited<ReturnType<typeof result.current.exportDeck>>;
    await act(async () => {
      prepared = await result.current.exportDeck();
    });

    expect(order.slice(0, 3)).toEqual(["flush", "mutation", "document"]);
    expect(prepared.html).toContain("Committed inline");
    expect(result.current.history).toMatchObject({
      size: 1,
      cursor: 1,
    });
  });

  it("preserves the session and fails export when inline text cannot be acknowledged", async () => {
    let emitInlineCommit!: () => void;
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn(async () => {
        emitInlineCommit();
      }),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: recoveryStore(),
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    const token = result.current.state.session!.token;
    emitInlineCommit = () => {
      result.current.handleFrameMessage({
        type: "hse:inline-text-commit",
        token,
        targetId: "node-1",
        before: "Introduction",
        after: "Unacknowledged inline",
      });
    };
    act(() => {
      result.current.frameRef.current = frame;
    });

    await act(async () => {
      await expect(result.current.exportDeck()).rejects.toThrow(
        "인라인 편집을 확정할 수 없습니다.",
      );
    });

    expect(frame.requestDocument).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      status: "ready",
      session: { fileName: "deck.html" },
      error: "인라인 편집을 확정할 수 없습니다.",
    });
  });

  it("holds later commands until export runtime validation releases its revision", async () => {
    const validation = deferred<{ ok: true }>();
    const requestMutation = vi.fn(acknowledgeMutation(mutationResult({
      command: command(),
      overrides: {},
      slideCount: 2,
      activeSlideIndex: 0,
    })));
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn().mockResolvedValue(undefined),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
      requestMutation,
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: recoveryStore(),
        validateRuntime: vi.fn(() => validation.promise),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });

    let exportPromise!: ReturnType<typeof result.current.exportDeck>;
    let commandPromise!: ReturnType<typeof result.current.sendCommand>;
    act(() => {
      exportPromise = result.current.exportDeck();
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe("exporting");
    });
    act(() => {
      commandPromise = result.current.sendCommand(command());
    });
    await Promise.resolve();

    expect(requestMutation).not.toHaveBeenCalled();

    validation.resolve({ ok: true });
    await act(async () => {
      await exportPromise;
      await commandPromise;
    });

    expect(requestMutation).toHaveBeenCalledOnce();
  });

  it("serializes deferred recovery writes so the later generation commits last", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const store = recoveryStore();
    store.saveRecovery
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const first = command();
    const second = { ...command(), id: "move-2", label: "Move again" };
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn().mockResolvedValue(undefined),
      requestMutation: vi
        .fn()
        .mockImplementationOnce(acknowledgeMutation(mutationResult({
          command: first,
          overrides: { "node-1": { translate: "20px 0px" } },
          slideCount: 2,
          activeSlideIndex: 0,
        })))
        .mockImplementationOnce(acknowledgeMutation(mutationResult({
          command: second,
          overrides: { "node-1": { translate: "40px 0px" } },
          slideCount: 2,
          activeSlideIndex: 0,
        }))),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(first);
      await vi.advanceTimersByTimeAsync(500);
      await result.current.sendCommand(second);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(store.saveRecovery).toHaveBeenCalledOnce();

    firstWrite.resolve();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(store.saveRecovery).toHaveBeenCalledTimes(2);
    expect(store.saveRecovery.mock.calls[1][0]).toMatchObject({
      commands: [first, second],
      historyCursor: 2,
      overrides: { "node-1": { translate: "40px 0px" } },
    });

    secondWrite.resolve();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("waits for pending recovery writes before preserving markExported", async () => {
    vi.useFakeTimers();
    const write = deferred<void>();
    const store = recoveryStore();
    store.saveRecovery.mockImplementationOnce(() => write.promise);
    const frame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn().mockResolvedValue(undefined),
      requestMutation: vi.fn(acknowledgeMutation(mutationResult({
        command: command(),
        overrides: {},
        slideCount: 2,
        activeSlideIndex: 0,
      }))),
      requestDocument: vi.fn().mockResolvedValue(VALID_MINIMAL_DECK),
    };
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
        now: () => 1_000,
      }),
    );
    await act(async () => {
      await result.current.openFile(
        immediateFile("deck.html", VALID_MINIMAL_DECK),
      );
    });
    act(() => {
      result.current.frameRef.current = frame;
    });
    await act(async () => {
      await result.current.sendCommand(command());
      await vi.advanceTimersByTimeAsync(500);
    });

    let markPromise!: ReturnType<typeof result.current.markRecoveryExported>;
    act(() => {
      markPromise = result.current.markRecoveryExported();
    });
    await Promise.resolve();
    expect(store.markExported).not.toHaveBeenCalled();

    write.resolve();
    await act(async () => {
      await expect(markPromise).resolves.toBe(true);
    });
    expect(store.markExported).toHaveBeenCalledWith(
      result.current.state.session!.token,
      1_000,
    );
  });

  it("preserves untouched restored overrides through patch, undo, save, and export", async () => {
    const restoredHtml = VALID_MINIMAL_DECK.replace(
      "<h1>Introduction</h1>",
      '<h1 data-hse-id="node-1">Introduction</h1><p data-hse-id="node-2">Untouched</p>',
    );
    const store = recoveryStore(
      recoveryRecord({
        html: restoredHtml,
        overrides: {
          "node-1": { color: "red" },
          "node-2": { "font-size": "24px" },
        },
        commands: [],
        historyCursor: 0,
      }),
    );
    const { result } = renderHook(() =>
      useDeckSession({
        recoveryStore: store,
        validateRuntime: vi.fn().mockResolvedValue({ ok: true }),
      }),
    );
    await waitFor(() => {
      expect(result.current.recovery).not.toBeNull();
    });
    await act(async () => {
      await result.current.restoreRecovery();
    });
    vi.useFakeTimers();

    const dom = new JSDOM(result.current.state.session!.srcDoc, {
      runScripts: "outside-only",
      url: "https://deck.test/",
    });
    const sent: Array<Record<string, unknown>> = [];
    dom.window.postMessage = ((message: Record<string, unknown>) => {
      sent.push(message);
    }) as typeof dom.window.postMessage;
    const script = dom.window.document.querySelector<HTMLScriptElement>(
      "script[data-hse-editor-bridge]",
    )!;
    dom.window.eval(script.textContent);
    let requestSequence = 0;
    const token = result.current.state.session!.token;
    const runtimeFrame: DeckFrameHandle = {
      send: vi.fn(),
      commitInlineEdit: vi.fn().mockResolvedValue(undefined),
      requestMutation: vi.fn(async (payload, installCheckpoint) => {
        sent.length = 0;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: dom.window,
            data: {
              ...payload,
              token,
              requestId: `mutation-${++requestSequence}`,
            },
          }),
        );
        const acknowledgement = sent.find(
          (message) => message.type === "hse:mutation-ack",
        ) as {
          status: "success";
          result: Awaited<
            ReturnType<NonNullable<DeckFrameHandle["requestMutation"]>>
          >;
        };
        const result = structuredClone(acknowledgement.result);
        installCheckpoint(result);
        return result;
      }),
      requestDocument: vi.fn(async () => {
        sent.length = 0;
        const requestId = `document-${++requestSequence}`;
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: dom.window,
            data: {
              type: "hse:request-document",
              token,
              requestId,
            },
          }),
        );
        return (
          sent.find(
            (message) =>
              message.type === "hse:document" &&
              message.requestId === requestId,
          ) as { html: string }
        ).html;
      }),
    };
    act(() => {
      result.current.frameRef.current = runtimeFrame;
    });

    await act(async () => {
      await result.current.sendCommand({
        id: "restored-patch",
        label: "Patch restored",
        kind: "patch",
        targetId: "node-1",
        before: { color: "red" },
        after: { color: "green" },
      });
    });
    expect(result.current.state.session?.overrides).toEqual({
      "node-1": { color: "green" },
      "node-2": { "font-size": "24px" },
    });

    await act(async () => {
      await result.current.undo();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.state.session?.overrides).toEqual({
      "node-1": { color: "red" },
      "node-2": { "font-size": "24px" },
    });

    let prepared!: Awaited<ReturnType<typeof result.current.exportDeck>>;
    await act(async () => {
      prepared = await result.current.exportDeck();
    });

    expect(store.saveRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        overrides: {
          "node-1": { color: "red" },
          "node-2": { "font-size": "24px" },
        },
        historyCursor: 0,
      }),
    );
    expect(prepared.html).toContain('[data-hse-id="node-1"]');
    expect(prepared.html).toContain('[data-hse-id="node-2"]');
  });
});
