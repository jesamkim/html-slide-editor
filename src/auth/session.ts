import { z } from "zod";
import type { AuthConfig } from "./authConfig";
import { codeChallengeFor, randomUrlSafeString } from "./pkce";
import { authStores, type AuthStores } from "./stores";

const TOKEN_STORAGE_KEY = "html-slide-editor:auth";
const PENDING_STORAGE_KEY = "html-slide-editor:auth-pending";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});

const StoredTokensSchema = z
  .object({
    accessToken: z.string().min(1),
    idToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().positive(),
  })
  .strict();

export type StoredTokens = z.infer<typeof StoredTokensSchema>;

const PendingLoginSchema = z
  .object({
    verifier: z.string().min(1),
    state: z.string().min(1),
  })
  .strict();

export class AuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
  }
}

export const readStoredTokens = (
  stores: AuthStores = authStores(),
): StoredTokens | null => {
  const raw = stores.persistent.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = StoredTokensSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const storeTokens = (
  tokens: StoredTokens,
  stores: AuthStores = authStores(),
) => {
  stores.persistent.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
};

export const clearStoredTokens = (stores: AuthStores = authStores()) => {
  stores.persistent.removeItem(TOKEN_STORAGE_KEY);
};

export const isFresh = (tokens: StoredTokens, now = Date.now()) =>
  tokens.expiresAt - now > REFRESH_MARGIN_MS;

export const millisecondsUntilRefresh = (
  tokens: StoredTokens,
  now = Date.now(),
) => Math.max(0, tokens.expiresAt - now - REFRESH_MARGIN_MS);

const tokenEndpoint = (config: AuthConfig) =>
  `https://${config.hostedUiDomain}/oauth2/token`;

const postToken = async (config: AuthConfig, body: URLSearchParams) => {
  const response = await fetch(tokenEndpoint(config), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new AuthError(`토큰 요청이 ${response.status}로 실패했습니다.`);
  }
  const parsed = TokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AuthError("토큰 응답 형식을 해석할 수 없습니다.");
  }
  return parsed.data;
};

export async function beginLogin(
  config: AuthConfig,
  stores: AuthStores = authStores(),
) {
  const verifier = randomUrlSafeString();
  const state = randomUrlSafeString(16);
  stores.transient.setItem(
    PENDING_STORAGE_KEY,
    JSON.stringify({ verifier, state }),
  );

  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email profile",
    state,
    code_challenge_method: "S256",
    code_challenge: await codeChallengeFor(verifier),
  });
  window.location.assign(
    `https://${config.hostedUiDomain}/oauth2/authorize?${query}`,
  );
}

export async function consumeAuthorizationCode(
  config: AuthConfig,
  search = window.location.search,
  stores: AuthStores = authStores(),
): Promise<StoredTokens | null> {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error) {
    stores.transient.removeItem(PENDING_STORAGE_KEY);
    throw new AuthError(
      `로그인이 거부되었습니다: ${params.get("error_description") ?? error}`,
    );
  }

  const code = params.get("code");
  if (!code) return null;

  const rawPending = stores.transient.getItem(PENDING_STORAGE_KEY);
  stores.transient.removeItem(PENDING_STORAGE_KEY);
  let pending: z.infer<typeof PendingLoginSchema> | null = null;
  if (rawPending) {
    try {
      const parsed = PendingLoginSchema.safeParse(JSON.parse(rawPending));
      if (parsed.success) pending = parsed.data;
    } catch {
      pending = null;
    }
  }
  if (!pending) {
    throw new AuthError("로그인 요청 기록이 없어 응답을 검증할 수 없습니다.");
  }
  if (params.get("state") !== pending.state) {
    throw new AuthError("로그인 응답의 state가 일치하지 않습니다.");
  }

  const token = await postToken(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: pending.verifier,
    }),
  );
  if (!token.refresh_token) {
    throw new AuthError("토큰 응답에 refresh token이 없습니다.");
  }

  return {
    accessToken: token.access_token,
    idToken: token.id_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}

export async function refreshTokens(
  config: AuthConfig,
  current: StoredTokens,
): Promise<StoredTokens> {
  const token = await postToken(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: current.refreshToken,
    }),
  );
  return {
    accessToken: token.access_token,
    idToken: token.id_token,
    refreshToken: token.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}

export const stripAuthQuery = () => {
  const url = new URL(window.location.href);
  for (const key of ["code", "state", "error", "error_description"]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", url.toString());
};
