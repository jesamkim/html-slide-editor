import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  DeckFrameHandle,
  InstalledMutationCheckpoint,
} from "../../bridge/DeckFrame";
import type { MutationRequestPayload } from "../../bridge/DeckFrame";
import {
  SerializableEditCommandSchema,
  type FrameToParentMessage,
} from "../../bridge/protocol";
import { injectBridge } from "../../bridge/injectBridge";
import { parseDeckHtml } from "../../core/document/parseDeck";
import {
  countHtmlIds,
  prepareExport,
} from "../../core/export/exportDocument";
import {
  validateExportInFrame,
  validateExportStructure,
  type ExportValidationResult,
} from "../../core/export/validateExport";
import {
  CommandHistory,
  type HistorySnapshot,
  type SerializableEditCommand,
} from "../../core/history/commandHistory";
import { keyboardDelta, type ArrowKey } from "../../core/interaction/geometry";
import {
  deleteRecovery,
  loadLatestRecoveryWithDiagnostics,
  markExported,
  saveRecovery,
  type RecoveryLoadResult,
  type RecoveryRecord,
} from "../../core/persistence/sessionStore";
import {
  editorReducer,
  initialEditorState,
  type EditorAction,
  type EditorSession,
  type EditorState,
} from "../state/editorReducer";

export type OpenDeckResult =
  | { status: "opened"; fingerprint: string }
  | { status: "rejected"; error: string }
  | { status: "superseded" };

export type CommandDispatchResult =
  | {
      status: "committed";
      command: SerializableEditCommand;
    }
  | {
      status: "pending";
      reason: "bridge-acknowledgement-unavailable";
      command: SerializableEditCommand;
    }
  | { status: "unavailable"; reason: "no-active-session" };

export type HistoryDispatchResult =
  | { status: "unavailable"; reason: "no-history-entry" }
  | { status: "committed" }
  | {
      status: "pending";
      reason: "bridge-acknowledgement-unavailable";
    };

export interface PreparedDeckExport {
  html: string;
  fileName: string;
  validation: ExportValidationResult;
}

interface AtomicSessionSnapshot {
  revision: number;
  session: EditorSession;
  history: HistorySnapshot;
  html: string;
}

export interface RecoveryStore {
  loadLatestRecoveryWithDiagnostics(): Promise<RecoveryLoadResult>;
  saveRecovery(record: RecoveryRecord): Promise<void>;
  markExported(id: IDBValidKey, exportedAt?: number): Promise<boolean>;
  deleteRecovery(id: IDBValidKey): Promise<void>;
}

export interface DeckSessionOptions {
  recoveryStore?: RecoveryStore;
  validateRuntime?: (
    html: string,
  ) => Promise<ExportValidationResult>;
  now?: () => number;
}

export interface DeckSessionController {
  state: EditorState;
  history: HistorySnapshot;
  recovery: RecoveryRecord | null;
  recoveryError: string | null;
  recoveryBusy: boolean;
  frameRef: MutableRefObject<DeckFrameHandle | null>;
  openFile(file: File): Promise<OpenDeckResult>;
  handleFrameMessage(message: FrameToParentMessage): void;
  sendCommand(
    command: SerializableEditCommand,
  ): Promise<CommandDispatchResult>;
  undo(): Promise<HistoryDispatchResult>;
  redo(): Promise<HistoryDispatchResult>;
  selectSlide(index: number): void;
  exportDeck(): Promise<PreparedDeckExport>;
  restoreRecovery(): Promise<boolean>;
  discardRecovery(): Promise<void>;
  markRecoveryExported(): Promise<boolean>;
}

class PendingBridgeAcknowledgementError extends Error {
  constructor() {
    super("The current bridge cannot acknowledge edit commands");
    this.name = "PendingBridgeAcknowledgementError";
  }
}

class DeckSessionCancelledError extends Error {
  constructor() {
    super("편집 세션이 취소되었습니다.");
    this.name = "DeckSessionCancelledError";
  }
}

const createPendingHistory = () =>
  new CommandHistory({
    async apply() {
      throw new PendingBridgeAcknowledgementError();
    },
  });

const defaultRecoveryStore: RecoveryStore = {
  async loadLatestRecoveryWithDiagnostics() {
    if (typeof indexedDB === "undefined") {
      return { recovery: null, corruptIds: [] };
    }
    return loadLatestRecoveryWithDiagnostics();
  },
  async saveRecovery(record) {
    return saveRecovery(record);
  },
  async markExported(id, exportedAt) {
    return markExported(id, exportedAt);
  },
  async deleteRecovery(id) {
    return deleteRecovery(id);
  },
};

const requireCrypto = (): Crypto => {
  if (
    !globalThis.crypto ||
    !globalThis.crypto.subtle ||
    typeof globalThis.crypto.getRandomValues !== "function"
  ) {
    throw new Error("이 브라우저는 안전한 세션 생성을 지원하지 않습니다.");
  }
  return globalThis.crypto;
};

export async function fingerprintHtml(source: string): Promise<string> {
  const digest = await requireCrypto().subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const createSessionToken = (): string => {
  const crypto = requireCrypto();
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) =>
    byte.toString(16).padStart(2, "0"),
  );
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "요청을 처리할 수 없습니다.";

const selectionFromPayload = (message: {
  targetId: string;
  path: string[];
  bounds: { x: number; y: number; width: number; height: number };
  kind: "text" | "image" | "svg" | "container";
  transform?: { translateX: number; translateY: number };
  snapTargets?: Array<{ axis: "x" | "y"; value: number; kind: string }>;
  text?: string | null;
  styles?: {
    fontSize?: string;
    color?: string;
    fontWeight?: string;
    textAlign?: "left" | "center" | "right";
  } | null;
}) => ({
  targetId: message.targetId,
  path: message.path,
  bounds: message.bounds,
  kind: message.kind,
  transform: message.transform,
  snapTargets: message.snapTargets,
  text: message.text ?? null,
  styles:
    message.styles?.fontSize &&
    message.styles.color &&
    message.styles.fontWeight &&
    message.styles.textAlign
      ? {
          fontSize: message.styles.fontSize,
          color: message.styles.color,
          fontWeight: message.styles.fontWeight,
          textAlign: message.styles.textAlign,
        }
      : null,
});

const selectionFromMessage = (
  message: Extract<FrameToParentMessage, { type: "hse:selection" }>,
) => selectionFromPayload(message);

const descriptorIndex = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    for (const key of ["index", "slideIndex", "fromIndex", "toIndex"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "number") return candidate;
    }
  }
  throw new Error("슬라이드 command index가 없습니다.");
};

const mutationPayload = (
  command: SerializableEditCommand,
  direction: "before" | "after",
  transition: "execute" | "undo" | "redo",
): MutationRequestPayload => {
  if (transition !== "execute") {
    return {
      type: "hse:apply-history",
      direction,
      command: SerializableEditCommandSchema.parse(command),
    };
  }

  switch (command.kind) {
    case "patch":
      return {
        type: "hse:apply-patch",
        commandId: command.id,
        label: command.label,
        targetId: command.targetId,
        patch: command.after as Extract<
          MutationRequestPayload,
          { type: "hse:apply-patch" }
        >["patch"],
      };
    case "duplicate-object":
    case "delete-object":
      return {
        type: `hse:${command.kind}`,
        commandId: command.id,
        label: command.label,
        targetId: command.targetId,
      };
    case "reorder-slide":
      return {
        type: "hse:reorder-slide",
        commandId: command.id,
        label: command.label,
        fromIndex: descriptorIndex(command.before),
        toIndex: descriptorIndex(command.after),
      };
    case "duplicate-slide":
    case "delete-slide":
      return {
        type: `hse:${command.kind}`,
        commandId: command.id,
        label: command.label,
        slideIndex: descriptorIndex(
          command.kind === "duplicate-slide"
            ? command.before
            : command.after,
        ),
      };
  }
};

export function useDeckSession(
  options: DeckSessionOptions = {},
): DeckSessionController {
  const recoveryStore = options.recoveryStore ?? defaultRecoveryStore;
  const validateRuntime =
    options.validateRuntime ?? validateExportInFrame;
  const now = options.now ?? Date.now;
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatchState = useCallback((action: EditorAction) => {
    stateRef.current = editorReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const frameRef = useRef<DeckFrameHandle | null>(null);
  const mountedRef = useRef(true);
  const importSequenceRef = useRef(0);
  const operationEpochRef = useRef(0);
  const operationTailRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef(0);
  const pendingInlineCommitRef = useRef<Promise<CommandDispatchResult> | null>(
    null,
  );
  const recoveryLoadSequenceRef = useRef(0);
  const recoverySaveGenerationRef = useRef(0);
  const recoverySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeRecoveryIdRef = useRef<string | null>(null);
  const recoveryWriteTailsRef = useRef(
    new Map<string, Promise<void>>(),
  );
  const previewUrlRef = useRef<string | null>(null);
  const readySyncInFlightTokenRef = useRef<string | null>(null);
  const readySyncCompletedTokenRef = useRef<string | null>(null);
  const historyRef = useRef(createPendingHistory());
  const historyTokenRef = useRef<string | null>(null);
  const sendCommandRef = useRef<
    ((command: SerializableEditCommand) => Promise<CommandDispatchResult>) | null
  >(null);
  const [history, setHistory] = useState<HistorySnapshot>(
    historyRef.current.snapshot(),
  );
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  const revokePreview = useCallback(() => {
    if (!previewUrlRef.current) return;
    URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  const cancelRecoverySave = useCallback(() => {
    recoverySaveGenerationRef.current += 1;
    if (recoverySaveTimerRef.current !== null) {
      clearTimeout(recoverySaveTimerRef.current);
      recoverySaveTimerRef.current = null;
    }
  }, []);

  const resetSessionOperations = useCallback(() => {
    operationEpochRef.current += 1;
    operationTailRef.current = Promise.resolve();
    revisionRef.current = 0;
    pendingInlineCommitRef.current = null;
  }, []);

  const enqueueSessionOperation = useCallback(
    <T,>(
      token: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      const epoch = operationEpochRef.current;
      const result = operationTailRef.current
        .catch(() => {})
        .then(async () => {
          if (
            !mountedRef.current ||
            operationEpochRef.current !== epoch ||
            stateRef.current.session?.token !== token
          ) {
            throw new DeckSessionCancelledError();
          }
          const value = await operation();
          if (
            !mountedRef.current ||
            operationEpochRef.current !== epoch ||
            stateRef.current.session?.token !== token
          ) {
            throw new DeckSessionCancelledError();
          }
          return value;
        });
      operationTailRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  const enqueueRecoveryWrite = useCallback(
    (record: RecoveryRecord): Promise<void> => {
      activeRecoveryIdRef.current = record.id;
      const previous =
        recoveryWriteTailsRef.current.get(record.id) ?? Promise.resolve();
      const write = previous
        .catch(() => {})
        .then(() => recoveryStore.saveRecovery(record));
      const tail = write.then(
        () => undefined,
        () => undefined,
      );
      recoveryWriteTailsRef.current.set(record.id, tail);
      void tail.finally(() => {
        if (recoveryWriteTailsRef.current.get(record.id) === tail) {
          recoveryWriteTailsRef.current.delete(record.id);
        }
      });
      return write;
    },
    [recoveryStore],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      importSequenceRef.current += 1;
      recoveryLoadSequenceRef.current += 1;
      cancelRecoverySave();
      resetSessionOperations();
      readySyncInFlightTokenRef.current = null;
      readySyncCompletedTokenRef.current = null;
      revokePreview();
    };
  }, [cancelRecoverySave, resetSessionOperations, revokePreview]);

  useEffect(() => {
    const loadSequence = ++recoveryLoadSequenceRef.current;
    void recoveryStore.loadLatestRecoveryWithDiagnostics().then(
      (result) => {
        if (
          !mountedRef.current ||
          loadSequence !== recoveryLoadSequenceRef.current
        ) {
          return;
        }
        setRecovery(result.recovery);
        setRecoveryError(
          result.corruptIds.length > 0
            ? `손상된 복구 기록 ${result.corruptIds.length}개를 건너뛰었습니다.`
            : null,
        );
      },
      (error) => {
        if (
          mountedRef.current &&
          loadSequence === recoveryLoadSequenceRef.current
        ) {
          setRecoveryError(errorMessage(error));
        }
      },
    );
    return () => {
      if (recoveryLoadSequenceRef.current === loadSequence) {
        recoveryLoadSequenceRef.current += 1;
      }
    };
  }, [recoveryStore]);

  const openFile = useCallback(
    async (file: File): Promise<OpenDeckResult> => {
      const requestSequence = ++importSequenceRef.current;
      dispatchState({ type: "importStarted" });

      try {
        const sourceHtml = await file.text();
        if (
          !mountedRef.current ||
          requestSequence !== importSequenceRef.current
        ) {
          return { status: "superseded" };
        }

        const parsed = parseDeckHtml(sourceHtml, file.name);
        if (!parsed.ok) {
          dispatchState({ type: "importFailed", error: parsed.message });
          return { status: "rejected", error: parsed.message };
        }

        const fingerprint = await fingerprintHtml(sourceHtml);
        if (
          !mountedRef.current ||
          requestSequence !== importSequenceRef.current
        ) {
          return { status: "superseded" };
        }

        const token = createSessionToken();
        const srcDoc = injectBridge(sourceHtml, token);
        if (
          !mountedRef.current ||
          requestSequence !== importSequenceRef.current
        ) {
          return { status: "superseded" };
        }

        cancelRecoverySave();
        resetSessionOperations();
        revokePreview();
        activeRecoveryIdRef.current = null;
        readySyncInFlightTokenRef.current = null;
        readySyncCompletedTokenRef.current = null;
        historyRef.current = createPendingHistory();
        historyTokenRef.current = null;
        setHistory(historyRef.current.snapshot());

        const session: EditorSession = {
          token,
          fingerprint,
          baselineIdCounts: countHtmlIds(parsed.document),
          fileName: file.name,
          sourceHtml,
          workingHtml: sourceHtml,
          srcDoc,
          recoverySrcDoc: srcDoc,
          overrides: {},
          previewUrl: null,
          activeSlide: 1,
          slideCount: parsed.metadata.slideCount,
          stageSize: parsed.metadata.stageSize,
          dirty: false,
        };
        dispatchState({ type: "importSucceeded", session });
        return { status: "opened", fingerprint };
      } catch (error) {
        if (
          !mountedRef.current ||
          requestSequence !== importSequenceRef.current
        ) {
          return { status: "superseded" };
        }

        const message = errorMessage(error);
        dispatchState({ type: "importFailed", error: message });
        return { status: "rejected", error: message };
      }
    },
    [cancelRecoverySave, dispatchState, resetSessionOperations, revokePreview],
  );

  const syncDocument = useCallback(
    async (
      token: string,
      dirty: boolean,
      previewOverrides?: EditorSession["overrides"],
    ) => {
      const frame = frameRef.current;
      if (!frame) {
        throw new Error("편집 프레임이 준비되지 않았습니다.");
      }

      const html = await frame.requestDocument();
      const current = stateRef.current.session;
      if (!mountedRef.current || current?.token !== token) return;

      const parsed = parseDeckHtml(html, current.fileName);
      if (!parsed.ok) throw new Error(parsed.message);
      if (parsed.document.querySelector("[data-hse-editor-bridge]")) {
        throw new Error("브리지 없는 작업 문서를 받지 못했습니다.");
      }

      const previewHtml = prepareExport(parsed.document, {
        overrides: previewOverrides ?? current.overrides,
      });
      const recoverySrcDoc = injectBridge(html, token, {
        initialOverrides: previewOverrides ?? current.overrides,
      });
      const previewUrl = URL.createObjectURL(
        new Blob([previewHtml], { type: "text/html" }),
      );
      if (
        !mountedRef.current ||
        stateRef.current.session?.token !== token
      ) {
        URL.revokeObjectURL(previewUrl);
        return;
      }

      revokePreview();
      previewUrlRef.current = previewUrl;
      dispatchState({
        type: "documentSynced",
        token,
        html,
        recoverySrcDoc,
        previewUrl,
        dirty,
      });
    },
    [dispatchState, revokePreview],
  );

  const reportSessionFailure = useCallback(
    (token: string, error: unknown) => {
      if (
        mountedRef.current &&
        stateRef.current.session?.token === token
      ) {
        dispatchState({
          type: "sessionFailed",
          token,
          error: errorMessage(error),
        });
      }
    },
    [dispatchState],
  );

  const installMutationCheckpoint = useCallback(
    (
      token: string,
      result: Awaited<
        ReturnType<NonNullable<DeckFrameHandle["requestMutation"]>>
      >,
    ): InstalledMutationCheckpoint => {
      const current = stateRef.current.session;
      if (!mountedRef.current || current?.token !== token) {
        throw new DeckSessionCancelledError();
      }

      const validation = validateExportStructure(
        result.checkpointHtml,
        result.slideCount,
        current.baselineIdCounts,
      );
      if (!validation.ok) throw new Error(validation.message);

      const parsed = parseDeckHtml(result.checkpointHtml, current.fileName);
      if (!parsed.ok) throw new Error(parsed.message);
      const previewHtml = prepareExport(parsed.document, {
        overrides: result.overrides,
      });
      const recoverySrcDoc = injectBridge(result.checkpointHtml, token, {
        initialOverrides: result.overrides,
      });
      const previewUrl = URL.createObjectURL(
        new Blob([previewHtml], { type: "text/html" }),
      );
      if (
        !mountedRef.current ||
        stateRef.current.session?.token !== token
      ) {
        URL.revokeObjectURL(previewUrl);
        throw new DeckSessionCancelledError();
      }

      revokePreview();
      previewUrlRef.current = previewUrl;
      dispatchState({
        type: "mutationAcknowledged",
        token,
        html: result.checkpointHtml,
        recoverySrcDoc,
        previewUrl,
        overrides: result.overrides,
        slideCount: result.slideCount,
        activeSlideIndex: result.activeSlideIndex,
        selection: result.selection
          ? selectionFromPayload(result.selection)
          : null,
      });
      return { recoverySrcDoc };
    },
    [dispatchState, revokePreview],
  );

  const executeBridgeCommand = useCallback(
    async (
      command: SerializableEditCommand,
      direction: "before" | "after",
      transition: "execute" | "undo" | "redo",
    ) => {
      const session = stateRef.current.session;
      const frame = frameRef.current;
      if (!session || !frame?.requestMutation) {
        throw new PendingBridgeAcknowledgementError();
      }
      const token = session.token;
      const result = await frame.requestMutation(
        mutationPayload(command, direction, transition),
        (acknowledgement) =>
          installMutationCheckpoint(token, acknowledgement),
      );
      if (
        !mountedRef.current ||
        stateRef.current.session?.token !== token
      ) {
        throw new DeckSessionCancelledError();
      }
      return result.command;
    },
    [installMutationCheckpoint],
  );

  const captureSessionSnapshot = useCallback(
    async (
      token: string,
      providedHtml?: string,
    ): Promise<AtomicSessionSnapshot> => {
      const frame = frameRef.current;
      const revision = revisionRef.current;
      if (!frame) {
        throw new Error("복구 문서를 읽을 편집 프레임이 없습니다.");
      }
      const html = providedHtml ?? (await frame.requestDocument());
      const current = stateRef.current.session;
      if (
        !mountedRef.current ||
        current?.token !== token ||
        revisionRef.current !== revision
      ) {
        throw new DeckSessionCancelledError();
      }

      const parsed = parseDeckHtml(html, current.fileName);
      if (!parsed.ok) throw new Error(parsed.message);
      if (parsed.document.querySelector("[data-hse-editor-bridge]")) {
        throw new Error("브리지 없는 복구 문서를 받지 못했습니다.");
      }

      return {
        revision,
        session: structuredClone(current),
        history: historyRef.current.snapshot(),
        html,
      };
    },
    [],
  );

  const queueRecoverySnapshot = useCallback(
    (
      snapshot: AtomicSessionSnapshot,
      generation: number,
      waitForWrite: boolean,
    ): Promise<boolean> => {
      if (recoverySaveGenerationRef.current !== generation) {
        return Promise.resolve(false);
      }
      const recoveryId =
        activeRecoveryIdRef.current ?? snapshot.session.token;
      const record: RecoveryRecord = {
        id: recoveryId,
        fileName: snapshot.session.fileName,
        fingerprint: snapshot.session.fingerprint,
        baselineIdCounts: structuredClone(
          snapshot.session.baselineIdCounts,
        ),
        html: snapshot.html,
        activeSlide: snapshot.session.activeSlide,
        overrides: structuredClone(snapshot.session.overrides),
        commands: snapshot.history.commands,
        historyCursor: snapshot.history.cursor,
        exportedAt: null,
        updatedAt: now(),
      };
      const observed = enqueueRecoveryWrite(record).then(
        () => {
          if (
            mountedRef.current &&
            stateRef.current.session?.token === snapshot.session.token &&
            recoverySaveGenerationRef.current === generation
          ) {
            setRecoveryError(null);
          }
          return true;
        },
        (error) => {
          if (
            mountedRef.current &&
            stateRef.current.session?.token === snapshot.session.token &&
            recoverySaveGenerationRef.current === generation
          ) {
            setRecoveryError(errorMessage(error));
          }
          return false;
        },
      );
      if (waitForWrite) return observed;
      void observed;
      return Promise.resolve(true);
    },
    [enqueueRecoveryWrite, now],
  );

  const scheduleRecoverySave = useCallback(
    (token: string) => {
      cancelRecoverySave();
      const generation = recoverySaveGenerationRef.current;
      recoverySaveTimerRef.current = setTimeout(() => {
        recoverySaveTimerRef.current = null;
        void enqueueSessionOperation(token, async () => {
          try {
            const snapshot = await captureSessionSnapshot(token);
            await queueRecoverySnapshot(snapshot, generation, false);
          } catch (error) {
            if (
              mountedRef.current &&
              stateRef.current.session?.token === token &&
              recoverySaveGenerationRef.current === generation
            ) {
              setRecoveryError(errorMessage(error));
            }
          }
        });
      }, 500);
    },
    [
      cancelRecoverySave,
      captureSessionSnapshot,
      enqueueSessionOperation,
      queueRecoverySnapshot,
    ],
  );

  const handleFrameMessage = useCallback(
    (message: FrameToParentMessage) => {
      const current = stateRef.current.session;
      if (!current || current.token !== message.token) return;

      switch (message.type) {
        case "hse:ready":
          dispatchState({
            type: "frameReady",
            token: message.token,
            slideCount: message.slideCount,
          });
          if (current.activeSlide > 1) {
            frameRef.current?.send({
              type: "hse:select-slide",
              slideIndex: Math.min(
                current.activeSlide,
                message.slideCount,
              ) - 1,
            });
          }
          if (
            readySyncCompletedTokenRef.current === message.token ||
            readySyncInFlightTokenRef.current === message.token
          ) {
            return;
          }
          readySyncInFlightTokenRef.current = message.token;
          void (async () => {
            try {
              await enqueueSessionOperation(message.token, () =>
                syncDocument(message.token, false),
              );
              if (
                mountedRef.current &&
                stateRef.current.session?.token === message.token
              ) {
                readySyncCompletedTokenRef.current = message.token;
              }
            } catch (error) {
              reportSessionFailure(message.token, error);
            } finally {
              if (
                readySyncInFlightTokenRef.current === message.token
              ) {
                readySyncInFlightTokenRef.current = null;
              }
            }
          })();
          return;

        case "hse:selection":
          dispatchState({
            type: "selectionChanged",
            token: message.token,
            selection: selectionFromMessage(message),
          });
          return;

        case "hse:inline-text-commit":
          const inlineCommit = sendCommandRef.current?.({
            id: `text-${crypto.randomUUID()}`,
            label: "Edit text",
            kind: "patch",
            targetId: message.targetId,
            before: { text: message.before },
            after: { text: message.after },
          });
          if (inlineCommit) {
            pendingInlineCommitRef.current = inlineCommit;
            void inlineCommit.then(
              () => {
                if (pendingInlineCommitRef.current === inlineCommit) {
                  pendingInlineCommitRef.current = null;
                }
              },
              (error) => {
                if (pendingInlineCommitRef.current === inlineCommit) {
                  pendingInlineCommitRef.current = null;
                }
                reportSessionFailure(message.token, error);
              },
            );
          }
          return;

        case "hse:error":
          reportSessionFailure(
            message.token,
            new Error(
              message.slideIndex === null
                ? message.message
                : `슬라이드 ${message.slideIndex + 1}: ${message.message}`,
            ),
          );
          return;

        case "hse:editor-key": {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              message.key,
            ) ||
            message.altKey ||
            message.ctrlKey ||
            message.metaKey
          ) {
            return;
          }
          const selection = stateRef.current.selection;
          if (!selection) return;
          const delta = keyboardDelta(
            message.key as ArrowKey,
            message.shiftKey,
          );
          const currentTransform = selection.transform ?? {
            translateX: 0,
            translateY: 0,
          };
          void sendCommandRef.current
            ?.({
              id: `keyboard-${crypto.randomUUID()}`,
              label: "Move object",
              kind: "patch",
              targetId: selection.targetId,
              before: {
                translateX: currentTransform.translateX,
                translateY: currentTransform.translateY,
              },
              after: {
                translateX: currentTransform.translateX + delta.x,
                translateY: currentTransform.translateY + delta.y,
              },
            })
            .catch((error) => reportSessionFailure(message.token, error));
          return;
        }

        case "hse:document":
        case "hse:inline-text-flush":
        case "hse:mutation-ack":
          return;
      }
    },
    [
      dispatchState,
      enqueueSessionOperation,
      reportSessionFailure,
      syncDocument,
    ],
  );

  const executeCommandOperation = useCallback(
    async (
      token: string,
      command: SerializableEditCommand,
    ): Promise<CommandDispatchResult> => {
      if (historyTokenRef.current !== token) {
        historyRef.current = new CommandHistory({
          apply: executeBridgeCommand,
        });
        historyTokenRef.current = token;
        setHistory(historyRef.current.snapshot());
      }

      try {
        await historyRef.current.execute(command);
      } catch (error) {
        setHistory(historyRef.current.snapshot());
        if (error instanceof PendingBridgeAcknowledgementError) {
          return {
            status: "pending",
            reason: "bridge-acknowledgement-unavailable",
            command: structuredClone(command),
          };
        }
        throw error;
      }

      const snapshot = historyRef.current.snapshot();
      setHistory(snapshot);
      revisionRef.current += 1;
      scheduleRecoverySave(token);
      return {
        status: "committed",
        command: snapshot.commands[snapshot.cursor - 1],
      };
    },
    [executeBridgeCommand, scheduleRecoverySave],
  );

  const sendCommand = useCallback(
    (
      command: SerializableEditCommand,
    ): Promise<CommandDispatchResult> => {
      const session = stateRef.current.session;
      if (!session) {
        return Promise.resolve({
          status: "unavailable",
          reason: "no-active-session",
        });
      }
      return enqueueSessionOperation(session.token, () =>
        executeCommandOperation(session.token, command),
      );
    },
    [enqueueSessionOperation, executeCommandOperation],
  );
  sendCommandRef.current = sendCommand;

  const runHistoryTransition = useCallback(
    (direction: "undo" | "redo"): Promise<HistoryDispatchResult> => {
      const session = stateRef.current.session;
      if (!session) {
        return Promise.resolve({
          status: "unavailable",
          reason: "no-history-entry",
        });
      }
      return enqueueSessionOperation(session.token, async () => {
        const snapshot = historyRef.current.snapshot();
        if (
          (direction === "undo" && !snapshot.canUndo) ||
          (direction === "redo" && !snapshot.canRedo)
        ) {
          return { status: "unavailable", reason: "no-history-entry" };
        }

        try {
          await historyRef.current[direction]();
        } catch (error) {
          setHistory(historyRef.current.snapshot());
          if (error instanceof PendingBridgeAcknowledgementError) {
            return {
              status: "pending",
              reason: "bridge-acknowledgement-unavailable",
            };
          }
          throw error;
        }

        setHistory(historyRef.current.snapshot());
        revisionRef.current += 1;
        scheduleRecoverySave(session.token);
        return { status: "committed" };
      });
    },
    [enqueueSessionOperation, scheduleRecoverySave],
  );

  const undo = useCallback(
    () => runHistoryTransition("undo"),
    [runHistoryTransition],
  );
  const redo = useCallback(
    () => runHistoryTransition("redo"),
    [runHistoryTransition],
  );

  const selectSlide = useCallback((index: number) => {
    const session = stateRef.current.session;
    if (
      !session ||
      stateRef.current.status !== "ready" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > session.slideCount
    ) {
      return;
    }
    dispatchState({
      type: "activeSlideChanged",
      token: session.token,
      activeSlide: index,
    });
    frameRef.current?.send({
      type: "hse:select-slide",
      slideIndex: index - 1,
    });
  }, [dispatchState]);

  const restoreRecovery = useCallback(async (): Promise<boolean> => {
    const record = recovery;
    if (!record || recoveryBusy) return false;

    setRecoveryBusy(true);
    let previewUrl: string | null = null;
    try {
      const parsed = parseDeckHtml(record.html, record.fileName);
      if (!parsed.ok) throw new Error(parsed.message);

      const token = createSessionToken();
      const previewHtml = prepareExport(parsed.document, {
        overrides: record.overrides,
      });
      previewUrl = URL.createObjectURL(
        new Blob([previewHtml], { type: "text/html" }),
      );
      if (!mountedRef.current) {
        URL.revokeObjectURL(previewUrl);
        return false;
      }

      const restoredHistory = new CommandHistory({
        apply: executeBridgeCommand,
      });
      restoredHistory.restore(record.commands, record.historyCursor);

      importSequenceRef.current += 1;
      cancelRecoverySave();
      resetSessionOperations();
      revokePreview();
      frameRef.current = null;
      previewUrlRef.current = previewUrl;
      activeRecoveryIdRef.current = record.id;
      readySyncInFlightTokenRef.current = null;
      readySyncCompletedTokenRef.current = token;
      historyRef.current = restoredHistory;
      historyTokenRef.current = token;
      setHistory(restoredHistory.snapshot());
      dispatchState({
        type: "importSucceeded",
        session: {
          token,
          fingerprint: record.fingerprint,
          baselineIdCounts: structuredClone(record.baselineIdCounts),
          fileName: record.fileName,
          sourceHtml: record.html,
          workingHtml: record.html,
          srcDoc: injectBridge(record.html, token, {
            initialOverrides: record.overrides,
          }),
          recoverySrcDoc: injectBridge(record.html, token, {
            initialOverrides: record.overrides,
          }),
          overrides: structuredClone(record.overrides),
          previewUrl,
          activeSlide: Math.min(
            record.activeSlide,
            parsed.metadata.slideCount,
          ),
          slideCount: parsed.metadata.slideCount,
          stageSize: parsed.metadata.stageSize,
          dirty: true,
        },
      });
      previewUrl = null;
      setRecovery(null);
      setRecoveryError(null);
      return true;
    } catch (error) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (mountedRef.current) setRecoveryError(errorMessage(error));
      return false;
    } finally {
      if (mountedRef.current) setRecoveryBusy(false);
    }
  }, [
    cancelRecoverySave,
    dispatchState,
    executeBridgeCommand,
    recovery,
    recoveryBusy,
    resetSessionOperations,
    revokePreview,
  ]);

  const discardRecovery = useCallback(async (): Promise<void> => {
    const record = recovery;
    if (!record || recoveryBusy) return;

    setRecoveryBusy(true);
    try {
      await recoveryStore.deleteRecovery(record.id);
      if (mountedRef.current) {
        setRecovery((current) =>
          current?.id === record.id ? null : current,
        );
        setRecoveryError(null);
      }
    } catch (error) {
      if (mountedRef.current) setRecoveryError(errorMessage(error));
    } finally {
      if (mountedRef.current) setRecoveryBusy(false);
    }
  }, [recovery, recoveryBusy, recoveryStore]);

  const markRecoveryExported = useCallback(async (): Promise<boolean> => {
    const recoveryId = activeRecoveryIdRef.current;
    if (recoveryId === null) {
      if (mountedRef.current) {
        setRecoveryError("내보내기를 표시할 복구 기록이 없습니다.");
      }
      return false;
    }

    try {
      await recoveryWriteTailsRef.current.get(recoveryId);
      const marked = await recoveryStore.markExported(recoveryId, now());
      if (!marked) {
        throw new Error("내보낸 복구 기록을 찾을 수 없습니다.");
      }
      if (mountedRef.current) setRecoveryError(null);
      return true;
    } catch (error) {
      if (mountedRef.current) setRecoveryError(errorMessage(error));
      return false;
    }
  }, [now, recoveryStore]);

  const exportDeck = useCallback(async (): Promise<PreparedDeckExport> => {
    const session = stateRef.current.session;
    const frame = frameRef.current;
    if (!session || !frame) {
      throw new Error("내보낼 편집 세션이 없습니다.");
    }

    const isCurrentSession = () =>
      mountedRef.current &&
      stateRef.current.session?.token === session.token;
    const assertCurrentSession = () => {
      if (!isCurrentSession()) {
        throw new DeckSessionCancelledError();
      }
    };

    dispatchState({ type: "exportStarted", token: session.token });
    try {
      await enqueueSessionOperation(session.token, async () => {
        await frame.commitInlineEdit?.();
      });
      const inlineCommit = pendingInlineCommitRef.current;
      if (inlineCommit) {
        const inlineResult = await inlineCommit;
        if (inlineResult.status !== "committed") {
          throw new Error("인라인 편집을 확정할 수 없습니다.");
        }
      }

      return await enqueueSessionOperation(session.token, async () => {
        const snapshot = await captureSessionSnapshot(session.token);
        const working = parseDeckHtml(
          snapshot.html,
          snapshot.session.fileName,
        );
        if (!working.ok) throw new Error(working.message);
        const html = prepareExport(working.document, {
          overrides: snapshot.session.overrides,
        });
        const structuralValidation = validateExportStructure(
          html,
          snapshot.session.slideCount,
          snapshot.session.baselineIdCounts,
        );
        if (!structuralValidation.ok) {
          throw new Error(structuralValidation.message);
        }

        const validation = await validateRuntime(html);
        if (!validation.ok) {
          throw new Error(validation.message);
        }
        if (revisionRef.current !== snapshot.revision) {
          throw new Error("편집 revision이 변경되어 내보내기를 중단했습니다.");
        }

        cancelRecoverySave();
        const persisted = await queueRecoverySnapshot(
          snapshot,
          recoverySaveGenerationRef.current,
          true,
        );
        if (!persisted) {
          throw new Error(
            recoveryError ?? "복구 기록을 저장할 수 없습니다.",
          );
        }
        const prepared = {
          html,
          fileName: snapshot.session.fileName,
          validation,
        };
        assertCurrentSession();
        dispatchState({
          type: "exportSucceeded",
          token: session.token,
        });
        return prepared;
      });
    } catch (error) {
      if (
        error instanceof DeckSessionCancelledError ||
        !isCurrentSession()
      ) {
        throw new DeckSessionCancelledError();
      }
      dispatchState({
        type: "exportFailed",
        token: session.token,
        error: errorMessage(error),
      });
      throw error;
    }
  }, [
    cancelRecoverySave,
    captureSessionSnapshot,
    dispatchState,
    enqueueSessionOperation,
    queueRecoverySnapshot,
    recoveryError,
    validateRuntime,
  ]);

  return {
    state,
    history,
    recovery,
    recoveryError,
    recoveryBusy,
    frameRef,
    openFile,
    handleFrameMessage,
    sendCommand,
    undo,
    redo,
    selectSlide,
    exportDeck,
    restoreRecovery,
    discardRecovery,
    markRecoveryExported,
  };
}
