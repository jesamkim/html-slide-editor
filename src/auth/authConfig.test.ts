import { describe, expect, it } from "vitest";
import { AuthConfigError, loadAuthConfig } from "./authConfig";

const respond = (body: string, status = 200) =>
  ((() =>
    Promise.resolve(
      new Response(body, { status }),
    )) as unknown) as typeof fetch;

const rejecting = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

const validConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_abc123",
  clientId: "1h57kf5cpq17m0eml12EXAMPLE",
  hostedUiDomain: "hse-example-0123456789ab.auth.us-east-1.amazoncognito.com",
  redirectUri: "https://d111111abcdef8.cloudfront.net/",
};

describe("loadAuthConfig", () => {
  it("returns the deployed configuration", async () => {
    await expect(
      loadAuthConfig({
        fetchImpl: respond(JSON.stringify(validConfig)),
        hostname: "d111111abcdef8.cloudfront.net",
      }),
    ).resolves.toEqual(validConfig);
  });

  it("runs without a gate on localhost when the file is absent", async () => {
    await expect(
      loadAuthConfig({
        fetchImpl: respond("not found", 404),
        hostname: "127.0.0.1",
      }),
    ).resolves.toBeNull();
  });

  it("runs without a gate on localhost when a dev server falls back to index.html", async () => {
    await expect(
      loadAuthConfig({
        fetchImpl: respond("<!doctype html><html></html>"),
        hostname: "localhost",
      }),
    ).resolves.toBeNull();
  });

  it("refuses to open a deployed origin when the file is absent", async () => {
    await expect(
      loadAuthConfig({
        fetchImpl: respond("not found", 404),
        hostname: "d111111abcdef8.cloudfront.net",
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
  });

  it("refuses to open a deployed origin when the file is not JSON", async () => {
    await expect(
      loadAuthConfig({
        fetchImpl: respond("<!doctype html><html></html>"),
        hostname: "d111111abcdef8.cloudfront.net",
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
  });

  it("refuses to open a deployed origin when a required key is missing", async () => {
    const { clientId: _omitted, ...incomplete } = validConfig;
    await expect(
      loadAuthConfig({
        fetchImpl: respond(JSON.stringify(incomplete)),
        hostname: "d111111abcdef8.cloudfront.net",
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
  });

  it("refuses to open a deployed origin when the request itself fails", async () => {
    await expect(
      loadAuthConfig({
        fetchImpl: rejecting,
        hostname: "d111111abcdef8.cloudfront.net",
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
  });
});
