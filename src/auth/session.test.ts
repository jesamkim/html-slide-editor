import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./authConfig";
import {
  AuthError,
  consumeAuthorizationCode,
  isFresh,
  millisecondsUntilRefresh,
  readStoredTokens,
  refreshTokens,
  storeTokens,
} from "./session";
import { createMemoryStorage, type AuthStores } from "./stores";

const config: AuthConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_abc123",
  clientId: "1h57kf5cpq17m0eml12EXAMPLE",
  hostedUiDomain: "editor.auth.us-east-1.amazoncognito.com",
  redirectUri: "https://d111111abcdef8.cloudfront.net/",
};

const tokens = {
  accessToken: "access-1",
  idToken: "id-1",
  refreshToken: "refresh-1",
  expiresAt: 1_000_000,
};

let stores: AuthStores;

const pend = (verifier: string, state: string) => {
  stores.transient.setItem(
    "html-slide-editor:auth-pending",
    JSON.stringify({ verifier, state }),
  );
};

const stubFetch = (payload: unknown, status = 200) => {
  const fetchMock = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(payload), { status })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

beforeEach(() => {
  stores = {
    persistent: createMemoryStorage(),
    transient: createMemoryStorage(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("stored tokens", () => {
  it("round-trips a token set", () => {
    storeTokens(tokens, stores);
    expect(readStoredTokens(stores)).toEqual(tokens);
  });

  it("returns null when nothing was stored", () => {
    expect(readStoredTokens(stores)).toBeNull();
  });

  it("ignores a corrupted entry instead of throwing", () => {
    stores.persistent.setItem("html-slide-editor:auth", "{not json");
    expect(readStoredTokens(stores)).toBeNull();
  });

  it("ignores an entry that lost a field", () => {
    stores.persistent.setItem(
      "html-slide-editor:auth",
      JSON.stringify({ accessToken: "a", idToken: "b", expiresAt: 1 }),
    );
    expect(readStoredTokens(stores)).toBeNull();
  });
});

describe("expiry arithmetic", () => {
  it("treats a token inside the refresh margin as stale", () => {
    const now = tokens.expiresAt - 4 * 60 * 1000;
    expect(isFresh(tokens, now)).toBe(false);
    expect(millisecondsUntilRefresh(tokens, now)).toBe(0);
  });

  it("schedules a refresh five minutes before expiry", () => {
    const now = tokens.expiresAt - 65 * 60 * 1000;
    expect(isFresh(tokens, now)).toBe(true);
    expect(millisecondsUntilRefresh(tokens, now)).toBe(60 * 60 * 1000);
  });
});

describe("consumeAuthorizationCode", () => {
  it("returns null when the URL carries no code", async () => {
    await expect(
      consumeAuthorizationCode(config, "", stores),
    ).resolves.toBeNull();
  });

  it("rejects a response whose state does not match the pending request", async () => {
    pend("v", "expected");
    await expect(
      consumeAuthorizationCode(config, "?code=abc&state=forged", stores),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a code with no pending request on record", async () => {
    await expect(
      consumeAuthorizationCode(config, "?code=abc&state=whatever", stores),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a code when the pending record is corrupted", async () => {
    stores.transient.setItem("html-slide-editor:auth-pending", "{not json");
    await expect(
      consumeAuthorizationCode(config, "?code=abc&state=s", stores),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("surfaces an error handed back by the hosted UI", async () => {
    await expect(
      consumeAuthorizationCode(
        config,
        "?error=access_denied&error_description=denied",
        stores,
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("exchanges the code with the stored verifier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    pend("verifier-1", "state-1");
    const fetchMock = stubFetch({
      access_token: "access-2",
      id_token: "id-2",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });

    await expect(
      consumeAuthorizationCode(config, "?code=abc&state=state-1", stores),
    ).resolves.toEqual({
      accessToken: "access-2",
      idToken: "id-2",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 3_600_000,
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://${config.hostedUiDomain}/oauth2/token`,
    );
    const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_id")).toBe(config.clientId);
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    expect(body.get("client_secret")).toBeNull();
    expect(
      stores.transient.getItem("html-slide-editor:auth-pending"),
    ).toBeNull();
  });

  it("fails when the token endpoint rejects the exchange", async () => {
    pend("v", "s");
    stubFetch({ error: "invalid_grant" }, 400);
    await expect(
      consumeAuthorizationCode(config, "?code=abc&state=s", stores),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("fails when the exchange returns no refresh token", async () => {
    pend("v", "s");
    stubFetch({ access_token: "a", id_token: "b", expires_in: 3600 });
    await expect(
      consumeAuthorizationCode(config, "?code=abc&state=s", stores),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("refreshTokens", () => {
  it("keeps the existing refresh token when the response omits one", async () => {
    stubFetch({ access_token: "access-3", id_token: "id-3", expires_in: 3600 });
    const next = await refreshTokens(config, tokens);
    expect(next.refreshToken).toBe("refresh-1");
    expect(next.accessToken).toBe("access-3");
  });

  it("sends the refresh grant with the client id", async () => {
    const fetchMock = stubFetch({
      access_token: "a",
      id_token: "b",
      expires_in: 3600,
    });
    await refreshTokens(config, tokens);
    const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("client_id")).toBe(config.clientId);
  });

  it("fails when the refresh is rejected", async () => {
    stubFetch({ error: "invalid_grant" }, 400);
    await expect(refreshTokens(config, tokens)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
