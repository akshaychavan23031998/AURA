import { AuthApi, AuthFailure } from "./auth-api";
import type { AccessTokenStore } from "./access-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class ApiFailure extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: "unauthenticated" | "request-failed",
  ) {
    super(code);
  }
}

export class AuthenticatedFetch {
  public constructor(
    private readonly tokens: AccessTokenStore,
    private readonly auth: AuthApi,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async request(input: URL, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    let response = await this.send(input, init);
    if (response.status !== 401) return ensureSuccess(response);
    if (!SAFE_METHODS.has(method)) throw new ApiFailure(401, "unauthenticated");
    try {
      await this.auth.refresh();
    } catch (error) {
      if (error instanceof AuthFailure)
        throw new ApiFailure(401, "unauthenticated");
      throw error;
    }
    response = await this.send(input, init);
    if (response.status === 401) throw new ApiFailure(401, "unauthenticated");
    return ensureSuccess(response);
  }

  private send(input: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = this.tokens.get();
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return this.fetcher(input, { ...init, headers, credentials: "include" });
  }
}

function ensureSuccess(response: Response): Response {
  if (!response.ok) throw new ApiFailure(response.status, "request-failed");
  return response;
}
