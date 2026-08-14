import { describe, expect, it, vi } from "vitest";
import { AccessTokenStore } from "./access-token";
import { AuthApi } from "./auth-api";
import { ApiFailure, AuthenticatedFetch } from "./authenticated-fetch";

const url = new URL("http://gateway.test/protected");
const jwt = (value: string) => `${value}.payload.signature`;

describe("AuthenticatedFetch", () => {
  it("attaches the latest access token and preserves request headers", async () => {
    const tokens = new AccessTokenStore();
    tokens.set(jwt("latest"));
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    await new AuthenticatedFetch(tokens, {} as AuthApi, fetcher).request(url, {
      headers: { "x-request-id": "request-1" },
    });
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${jwt("latest")}`);
    expect(headers.get("x-request-id")).toBe("request-1");
  });

  it("refreshes once and safely retries a GET with the replacement token", async () => {
    const tokens = new AccessTokenStore();
    tokens.set(jwt("old"));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const auth = {
      refresh: vi.fn().mockImplementation(() => {
        tokens.set(jwt("new"));
        return Promise.resolve(jwt("new"));
      }),
    } as unknown as AuthApi;
    const response = await new AuthenticatedFetch(
      tokens,
      auth,
      fetcher,
    ).request(url);
    expect(response.status).toBe(200);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      (fetcher.mock.calls[1]?.[1]?.headers as Headers).get("authorization"),
    ).toContain("new.payload");
  });

  it("does not replay an unsafe POST after a 401", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const auth = { refresh: vi.fn() } as unknown as AuthApi;
    await expect(
      new AuthenticatedFetch(new AccessTokenStore(), auth, fetcher).request(
        url,
        { method: "POST" },
      ),
    ).rejects.toEqual(new ApiFailure(401, "unauthenticated"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("fails closed when the retried request is still unauthorized", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const auth = {
      refresh: vi.fn().mockResolvedValue(jwt("new")),
    } as unknown as AuthApi;
    await expect(
      new AuthenticatedFetch(new AccessTokenStore(), auth, fetcher).request(
        url,
      ),
    ).rejects.toEqual(new ApiFailure(401, "unauthenticated"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
