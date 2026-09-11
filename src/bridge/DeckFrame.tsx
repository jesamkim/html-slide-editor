import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  FrameToParentMessageSchema,
  ParentToFrameMessageSchema,
  type FrameToParentMessage,
  type MutationAck,
  type MutationSuccess,
  type ParentToFrameMessage,
} from "./protocol";

export type ParentToFramePayload =
  ParentToFrameMessage extends infer Message
    ? Message extends { token: string }
      ? Omit<Message, "token">
      : never
    : never;

export interface DeckFrameHandle {
  send(message: ParentToFramePayload): void;
  requestDocument(): Promise<string>;
  commitInlineEdit?(): Promise<void>;
  requestMutation?(
    message: MutationRequestPayload,
    installCheckpoint: MutationCheckpointInstaller,
  ): Promise<MutationSuccess["result"]>;
}

export interface InstalledMutationCheckpoint {
  recoverySrcDoc: string;
}

export type MutationCheckpointInstaller = (
  result: MutationSuccess["result"],
) => InstalledMutationCheckpoint;

export interface DeckFrameProps {
  srcDoc: string;
  recoverySrcDoc?: string;
  token: string;
  onMessage(message: FrameToParentMessage): void;
  requestTimeoutMs?: number;
  mutationRetryCount?: number;
  className?: string;
  onFrameElement?(element: HTMLIFrameElement | null): void;
}

interface PendingDocumentRequest {
  requestId: string;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve(html: string): void;
  reject(reason: Error): void;
}

interface PendingMutationRequest {
  requestId: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
  attempts: number;
  payload: MutationRequestPayload;
  installCheckpoint: MutationCheckpointInstaller;
  resolve(result: MutationSuccess["result"]): void;
  reject(reason: Error): void;
}

interface PendingInlineRequest {
  requestId: string;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(reason: Error): void;
}

export type MutationRequestPayload = Extract<
  ParentToFramePayload,
  {
    type:
      | "hse:apply-patch"
      | "hse:duplicate-object"
      | "hse:delete-object"
      | "hse:reorder-slide"
      | "hse:duplicate-slide"
      | "hse:delete-slide"
      | "hse:apply-history";
  }
> extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, "requestId">
    : never
  : never;

export class DeckFrameRequestPendingError extends Error {
  constructor() {
    super("A deck document request is already pending");
    this.name = "DeckFrameRequestPendingError";
  }
}

export class DeckFrameRequestTimeoutError extends Error {
  constructor() {
    super("The deck document request timed out");
    this.name = "DeckFrameRequestTimeoutError";
  }
}

export class DeckFrameMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeckFrameMutationError";
  }
}

export class DeckFrameRequestReplacedError extends Error {
  constructor() {
    super("The deck frame session was replaced");
    this.name = "DeckFrameRequestReplacedError";
  }
}

export class DeckFrameUnavailableError extends Error {
  constructor() {
    super("The deck frame is not available");
    this.name = "DeckFrameUnavailableError";
  }
}

export const DeckFrame = forwardRef<DeckFrameHandle, DeckFrameProps>(
  function DeckFrame(
    {
      srcDoc,
      recoverySrcDoc = srcDoc,
      token,
      onMessage,
      requestTimeoutMs = 5_000,
      mutationRetryCount = 2,
      className,
      onFrameElement,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const pendingRequestRef = useRef<PendingDocumentRequest | null>(null);
    const pendingInlineRef = useRef<PendingInlineRequest | null>(null);
    const pendingMutationsRef = useRef(
      new Map<string, PendingMutationRequest>(),
    );
    const requestSequenceRef = useRef(0);
    const recoveryRejectsRef = useRef<
      Array<{
        pending: PendingMutationRequest;
        reason: Error;
      }>
    >([]);
    const installedRecoverySrcDocRef = useRef(recoverySrcDoc);
    const baseFrameKey = `${token}\u0000${srcDoc}`;
    const [recoveryFrame, setRecoveryFrame] = useState<{
      baseFrameKey: string;
      srcDoc: string;
      version: number;
    } | null>(null);
    const activeRecoveryFrame =
      recoveryFrame?.baseFrameKey === baseFrameKey
        ? recoveryFrame
        : null;

    useLayoutEffect(() => {
      installedRecoverySrcDocRef.current = recoverySrcDoc;
    }, [baseFrameKey, recoverySrcDoc]);

    const settlePending = useCallback(
      (
        requestId: string | null,
        settle: (pending: PendingDocumentRequest) => void,
      ) => {
        const pending = pendingRequestRef.current;
        if (
          !pending ||
          (requestId !== null && pending.requestId !== requestId)
        ) {
          return false;
        }

        pendingRequestRef.current = null;
        clearTimeout(pending.timeoutId);
        settle(pending);
        return true;
      },
      [],
    );

    const rejectPending = useCallback(
      (reason: Error) => {
        settlePending(null, (pending) => pending.reject(reason));
      },
      [settlePending],
    );

    const settleInline = useCallback(
      (
        requestId: string | null,
        settle: (pending: PendingInlineRequest) => void,
      ) => {
        const pending = pendingInlineRef.current;
        if (
          !pending ||
          (requestId !== null && pending.requestId !== requestId)
        ) {
          return false;
        }

        pendingInlineRef.current = null;
        clearTimeout(pending.timeoutId);
        settle(pending);
        return true;
      },
      [],
    );

    const rejectInline = useCallback(
      (reason: Error) => {
        settleInline(null, (pending) => pending.reject(reason));
      },
      [settleInline],
    );

    const settleMutation = useCallback(
      (
        requestId: string,
        settle: (pending: PendingMutationRequest) => void,
      ) => {
        const pending = pendingMutationsRef.current.get(requestId);
        if (!pending) return false;

        pendingMutationsRef.current.delete(requestId);
        if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
        settle(pending);
        return true;
      },
      [],
    );

    const rejectMutations = useCallback((reason: Error) => {
      const pending = [...pendingMutationsRef.current.values()];
      pendingMutationsRef.current.clear();
      for (const request of pending) {
        if (request.timeoutId !== null) clearTimeout(request.timeoutId);
        request.reject(reason);
      }
    }, []);

    const recoverMutation = useCallback(
      (pending: PendingMutationRequest, reason: Error) => {
        pendingMutationsRef.current.delete(pending.requestId);
        if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
        pending.timeoutId = null;
        recoveryRejectsRef.current.push({ pending, reason });
        setRecoveryFrame((current) => ({
          baseFrameKey,
          srcDoc: installedRecoverySrcDocRef.current,
          version: (current?.version ?? 0) + 1,
        }));
      },
      [baseFrameKey],
    );

    useLayoutEffect(() => {
      if (!activeRecoveryFrame) return;
      const pending = recoveryRejectsRef.current.splice(0);
      for (const request of pending) {
        request.pending.reject(request.reason);
      }
    }, [activeRecoveryFrame]);

    const postPayload = useCallback(
      (payload: ParentToFramePayload) => {
        const frameWindow = iframeRef.current?.contentWindow;
        if (!frameWindow) {
          throw new DeckFrameUnavailableError();
        }

        const message = ParentToFrameMessageSchema.parse({
          ...payload,
          token,
        });
        frameWindow.postMessage(message, "*");
      },
      [token],
    );

    useImperativeHandle(
      ref,
      () => ({
        send(message) {
          postPayload(message);
        },
        requestDocument() {
          if (pendingRequestRef.current) {
            return Promise.reject(new DeckFrameRequestPendingError());
          }

          const requestId = `document-${++requestSequenceRef.current}`;
          return new Promise<string>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              settlePending(requestId, (pending) => {
                pending.reject(new DeckFrameRequestTimeoutError());
              });
            }, requestTimeoutMs);
            pendingRequestRef.current = {
              requestId,
              timeoutId,
              resolve,
              reject,
            };

            try {
              postPayload({ type: "hse:request-document", requestId });
            } catch (error) {
              settlePending(requestId, (pending) => {
                pending.reject(
                  error instanceof Error
                    ? error
                    : new DeckFrameUnavailableError(),
                );
              });
            }
          });
        },
        commitInlineEdit() {
          if (pendingInlineRef.current) {
            return Promise.reject(new DeckFrameRequestPendingError());
          }

          const requestId = `inline-${++requestSequenceRef.current}`;
          return new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              settleInline(requestId, (pending) => {
                pending.reject(new DeckFrameRequestTimeoutError());
              });
            }, requestTimeoutMs);
            pendingInlineRef.current = {
              requestId,
              timeoutId,
              resolve,
              reject,
            };

            try {
              postPayload({ type: "hse:commit-inline-edit", requestId });
            } catch (error) {
              settleInline(requestId, (pending) => {
                pending.reject(
                  error instanceof Error
                    ? error
                    : new DeckFrameUnavailableError(),
                );
              });
            }
          });
        },
        requestMutation(message, installCheckpoint) {
          const requestId = `mutation-${++requestSequenceRef.current}`;
          return new Promise<MutationSuccess["result"]>(
            (resolve, reject) => {
              const pending: PendingMutationRequest = {
                requestId,
                timeoutId: null,
                attempts: 0,
                payload: message,
                installCheckpoint,
                resolve,
                reject,
              };
              pendingMutationsRef.current.set(requestId, pending);

              const sendAttempt = () => {
                if (pendingMutationsRef.current.get(requestId) !== pending) {
                  return;
                }
                try {
                  postPayload({
                    ...pending.payload,
                    requestId,
                  } as ParentToFramePayload);
                  pending.attempts += 1;
                  pending.timeoutId = setTimeout(() => {
                    if (
                      pendingMutationsRef.current.get(requestId) !== pending
                    ) {
                      return;
                    }
                    if (pending.attempts <= mutationRetryCount) {
                      sendAttempt();
                      return;
                    }

                    recoverMutation(
                      pending,
                      new DeckFrameRequestTimeoutError(),
                    );
                  }, requestTimeoutMs);
                } catch (error) {
                  settleMutation(requestId, (request) => {
                    request.reject(
                      error instanceof Error
                        ? error
                        : new DeckFrameUnavailableError(),
                    );
                  });
                }
              };

              sendAttempt();
            },
          );
        },
      }),
      [
        postPayload,
        mutationRetryCount,
        recoverMutation,
        requestTimeoutMs,
        settleInline,
        settleMutation,
        settlePending,
      ],
    );

    useEffect(() => {
      const handleMessage = (event: MessageEvent) => {
        if (
          !token ||
          event.source !== iframeRef.current?.contentWindow
        ) {
          return;
        }

        try {
          const parsed = FrameToParentMessageSchema.safeParse(event.data);
          if (!parsed.success || parsed.data.token !== token) return;

          if (parsed.data.type === "hse:document") {
            const html = parsed.data.html;
            if (
              !settlePending(parsed.data.requestId, (pending) => {
                pending.resolve(html);
              })
            ) {
              return;
            }
          } else if (parsed.data.type === "hse:inline-text-flush") {
            if (
              !settleInline(parsed.data.requestId, (pending) => {
                pending.resolve();
              })
            ) {
              return;
            }
          } else if (parsed.data.type === "hse:mutation-ack") {
            const acknowledgement = parsed.data as MutationAck;
            const pending = pendingMutationsRef.current.get(
              acknowledgement.requestId,
            );
            if (!pending) {
              return;
            }
            if (acknowledgement.status === "success") {
              const expectedCommandId =
                "commandId" in pending.payload
                  ? pending.payload.commandId
                  : pending.payload.command.id;
              if (acknowledgement.result.command.id !== expectedCommandId) {
                recoverMutation(
                  pending,
                  new DeckFrameMutationError(
                    "ACK_COMMAND_MISMATCH",
                    "The mutation acknowledgement command does not match the request",
                  ),
                );
                return;
              }
              try {
                const installed = pending.installCheckpoint(
                  acknowledgement.result,
                );
                installedRecoverySrcDocRef.current =
                  installed.recoverySrcDoc;
              } catch (error) {
                recoverMutation(
                  pending,
                  error instanceof Error
                    ? error
                    : new DeckFrameMutationError(
                        "INVALID_CHECKPOINT",
                        "The mutation checkpoint could not be installed",
                      ),
                );
                return;
              }
              settleMutation(acknowledgement.requestId, (request) => {
                request.resolve(acknowledgement.result);
              });
            } else {
              settleMutation(acknowledgement.requestId, (request) => {
                request.reject(
                  new DeckFrameMutationError(
                    acknowledgement.error.code,
                    acknowledgement.error.message,
                  ),
                );
              });
            }
          }

          onMessage(parsed.data);
        } catch {
          // Malformed cross-frame messages are untrusted input.
        }
      };

      window.addEventListener("message", handleMessage);
      return () => window.removeEventListener("message", handleMessage);
    }, [
      onMessage,
      recoverMutation,
      rejectInline,
      rejectPending,
      settleInline,
      settleMutation,
      settlePending,
      token,
    ]);

    useEffect(
      () => () => {
        const reason = new DeckFrameRequestReplacedError();
        rejectPending(reason);
        rejectInline(reason);
        rejectMutations(reason);
      },
      [rejectInline, rejectMutations, rejectPending, srcDoc, token],
    );

    return (
      <iframe
        key={`${baseFrameKey}\u0000${activeRecoveryFrame?.version ?? 0}`}
        ref={(element) => {
          iframeRef.current = element;
          onFrameElement?.(element);
        }}
        title="편집 중인 슬라이드"
        className={className}
        sandbox="allow-scripts"
        srcDoc={activeRecoveryFrame?.srcDoc ?? srcDoc}
      />
    );
  },
);
