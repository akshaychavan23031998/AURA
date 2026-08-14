import { z } from "zod";
import { resolveGatewayHttpUrl } from "../voice/gateway-url";
import type { AccessTokenStore } from "./access-token";

const tokenResponse = z.object({ accessToken: z.string().max(4_096) }).strict();

export class AuthFailure extends Error {
  public constructor(
    public readonly code:
      "unauthenticated" | "unavailable" | "invalid-response",
  ) {
    super(code);
  }
}

export class AuthApi {
  private refreshPromise?: Promise<string>;

  public constructor(
    private readonly tokens: AccessTokenStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl: URL = resolveGatewayHttpUrl(),
  ) {}

  public refresh(): Promise<string> {
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    const pending = this.requestToken("auth/refresh").finally(() => {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    });
    this.refreshPromise = pending;
    return pending;
  }

  public createDevelopmentSession(): Promise<string> {
    return this.requestToken("auth/development-session");
  }

  public async logout(): Promise<void> {
    try {
      let token = this.tokens.get();
      if (token !== undefined) {
        let response = await this.fetcher(
          new URL("api/v1/auth/logout", this.baseUrl),
          {
            method: "POST",
            credentials: "include",
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (response.status === 401) {
          token = await this.refresh();
          response = await this.fetcher(
            new URL("api/v1/auth/logout", this.baseUrl),
            {
              method: "POST",
              credentials: "include",
              headers: { authorization: `Bearer ${token}` },
            },
          );
        }
        if (!response.ok) throw new AuthFailure("unavailable");
      }
    } finally {
      this.tokens.clear();
    }
  }

  private async requestToken(path: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(`api/v1/${path}`, this.baseUrl), {
        method: "POST",
        credentials: "include",
      });
    } catch {
      this.tokens.clear();
      throw new AuthFailure("unavailable");
    }
    if (response.status === 401) {
      this.tokens.clear();
      throw new AuthFailure("unauthenticated");
    }
    if (!response.ok) throw new AuthFailure("unavailable");
    const parsed = tokenResponse.safeParse(await response.json());
    if (!parsed.success) throw new AuthFailure("invalid-response");
    this.tokens.set(parsed.data.accessToken);
    return parsed.data.accessToken;
  }
}
