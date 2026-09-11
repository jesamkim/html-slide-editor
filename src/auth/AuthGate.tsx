import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadAuthConfig, type AuthConfig } from "./authConfig";
import {
  beginLogin,
  clearStoredTokens,
  consumeAuthorizationCode,
  isFresh,
  millisecondsUntilRefresh,
  readStoredTokens,
  refreshTokens,
  storeTokens,
  stripAuthQuery,
  type StoredTokens,
} from "./session";

type GateStatus = "checking" | "allowed" | "error";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>("checking");
  const [message, setMessage] = useState<string | null>(null);
  const startedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const scheduleRefresh = (config: AuthConfig, tokens: StoredTokens) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void refreshTokens(config, tokens)
          .then((next) => {
            storeTokens(next);
            scheduleRefresh(config, next);
          })
          .catch(() => {
            clearStoredTokens();
            void beginLogin(config);
          });
      }, millisecondsUntilRefresh(tokens));
    };

    const admit = (config: AuthConfig, tokens: StoredTokens) => {
      storeTokens(tokens);
      scheduleRefresh(config, tokens);
      setStatus("allowed");
    };

    const run = async () => {
      const config = await loadAuthConfig();
      if (!config) {
        setStatus("allowed");
        return;
      }

      let redirected: StoredTokens | null;
      try {
        redirected = await consumeAuthorizationCode(config);
      } catch (cause) {
        stripAuthQuery();
        throw cause;
      }
      if (redirected) {
        stripAuthQuery();
        admit(config, redirected);
        return;
      }

      const stored = readStoredTokens();
      if (stored && isFresh(stored)) {
        admit(config, stored);
        return;
      }
      if (stored) {
        try {
          admit(config, await refreshTokens(config, stored));
          return;
        } catch {
          clearStoredTokens();
        }
      }
      await beginLogin(config);
    };

    void run().catch((error: unknown) => {
      setMessage(
        error instanceof Error
          ? error.message
          : "로그인을 진행할 수 없습니다.",
      );
      setStatus("error");
    });
  }, []);

  if (status === "allowed") return <>{children}</>;

  return (
    <div className="auth-gate" role="status" aria-live="polite">
      <div className="auth-gate__panel">
        <h1 className="auth-gate__title">HTML Slide Editor</h1>
        {status === "checking" ? (
          <p className="auth-gate__body">로그인 상태를 확인하고 있습니다.</p>
        ) : (
          <>
            <p className="auth-gate__body">{message}</p>
            <button
              type="button"
              className="auth-gate__retry"
              onClick={() => window.location.reload()}
            >
              다시 시도
            </button>
          </>
        )}
      </div>
    </div>
  );
}
