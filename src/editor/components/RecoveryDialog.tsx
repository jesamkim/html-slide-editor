import {
  useEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import type { RecoveryRecord } from "../../core/persistence/sessionStore";

export interface RecoveryDialogProps {
  recovery: RecoveryRecord;
  currentFingerprint: string | null;
  onRestore(): void | Promise<unknown>;
  onDiscard(): void | Promise<unknown>;
  busy?: boolean;
}

export function RecoveryDialog({
  recovery,
  currentFingerprint,
  onRestore,
  onDiscard,
  busy = false,
}: RecoveryDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const savedAt = new Date(recovery.updatedAt);
  const fingerprintMismatch =
    currentFingerprint !== null &&
    currentFingerprint !== recovery.fingerprint;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    (restoreRef.current ?? dialogRef.current)?.focus();
    return () => {
      previousFocus?.focus();
    };
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const actions = [discardRef.current, restoreRef.current].filter(
      (action): action is HTMLButtonElement =>
        action !== null && !action.disabled,
    );
    if (actions.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = actions[0];
    const last = actions[actions.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="recovery-dialog__backdrop">
      <section
        ref={dialogRef}
        aria-describedby="recovery-dialog-description"
        aria-label="편집 세션 복구"
        aria-modal="true"
        className="recovery-dialog"
        role="dialog"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <h2>편집 세션 복구</h2>
        <p id="recovery-dialog-description">
          저장된 편집 내용을 복구하거나 기록을 삭제하세요.
        </p>
        <dl className="recovery-dialog__details">
          <div>
            <dt>파일</dt>
            <dd>{recovery.fileName}</dd>
          </div>
          <div>
            <dt>저장 시각</dt>
            <dd>
              <time dateTime={savedAt.toISOString()}>
                {savedAt.toLocaleString()}
              </time>
            </dd>
          </div>
        </dl>
        {fingerprintMismatch ? (
          <p className="recovery-dialog__warning" role="alert">
            현재 열린 파일과 원본 지문이 다릅니다.
          </p>
        ) : null}
        <div className="recovery-dialog__actions">
          <button
            ref={discardRef}
            type="button"
            className="recovery-dialog__discard"
            disabled={busy}
            onClick={() => void onDiscard()}
          >
            복구 기록 삭제
          </button>
          <button
            ref={restoreRef}
            type="button"
            className="recovery-dialog__restore"
            disabled={busy}
            onClick={() => void onRestore()}
          >
            세션 복구
          </button>
        </div>
      </section>
    </div>
  );
}
