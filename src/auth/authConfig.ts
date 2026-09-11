import { z } from "zod";

export const AUTH_CONFIG_PATH = "/auth-config.json";

export const AuthConfigSchema = z
  .object({
    region: z.string().min(1),
    userPoolId: z.string().min(1),
    clientId: z.string().min(1),
    hostedUiDomain: z.string().min(1),
    redirectUri: z.string().url(),
  })
  .strict();

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export class AuthConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthConfigError";
  }
}

export const isLocalOrigin = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

export async function loadAuthConfig(options?: {
  fetchImpl?: typeof fetch;
  hostname?: string;
}): Promise<AuthConfig | null> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const hostname = options?.hostname ?? window.location.hostname;

  const unconfigured = (message: string, cause?: unknown) => {
    if (isLocalOrigin(hostname)) return null;
    throw new AuthConfigError(message, { cause });
  };

  let response: Response;
  try {
    response = await fetchImpl(AUTH_CONFIG_PATH, { cache: "no-store" });
  } catch (cause) {
    return unconfigured("로그인 설정을 요청할 수 없습니다.", cause);
  }

  if (!response.ok) {
    return unconfigured(
      `로그인 설정 응답이 ${response.status}입니다. 배포가 완료되었는지 확인하세요.`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch (cause) {
    return unconfigured("로그인 설정이 JSON이 아닙니다.", cause);
  }

  const parsed = AuthConfigSchema.safeParse(payload);
  if (!parsed.success) {
    return unconfigured("로그인 설정에 필요한 항목이 없습니다.");
  }
  return parsed.data;
}
