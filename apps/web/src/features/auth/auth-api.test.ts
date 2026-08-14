import { describe, expect, it, vi } from "vitest";
import { AccessTokenStore } from "./access-token";
import { AuthApi, AuthFailure } from "./auth-api";

const base = new URL("http://gateway.test/");
const jwt = (value: string) => `${value}.payload.signature`;

describe("AuthApi", () => {
  it("bootstraps a valid cookie session into memory", async () => {
    const tokens = new AccessTokenStore();
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ accessToken: jwt("new") }));
    await expect(new AuthApi(tokens, fetcher, base).refresh()).resolves.toBe(
      jwt("new"),
    );
    expect(tokens.get()).toBe(jwt("new"));
    expect(fetcher).toHaveBeenCalledWith(
      new URL("api/v1/auth/refresh", base),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("treats a missing or revoked browser session as unauthenticated", async () => {
    const tokens = new AccessTokenStore();
    tokens.set(jwt("old"));
    const api = new AuthApi(
      tokens,
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      base,
    );
    await expect(api.refresh()).rejects.toEqual(
      new AuthFailure("unauthenticated"),
    );
    expect(tokens.get()).toBeUndefined();
  });

  it("deduplicates concurrent refresh calls", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const api = new AuthApi(new AccessTokenStore(), fetcher, base);
    const first = api.refresh();
    const second = api.refresh();
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveResponse(json({ accessToken: jwt("rotated") }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      jwt("rotated"),
      jwt("rotated"),
    ]);
  });

  it("clears memory even if server logout fails", async () => {
    const tokens = new AccessTokenStore();
    tokens.set(jwt("active"));
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(new AuthApi(tokens, fetcher, base).logout()).rejects.toThrow(
      "offline",
    );
    expect(tokens.get()).toBeUndefined();
  });

  it("never writes access or refresh tokens to persistent browser storage", () => {
    const localSpy = vi.spyOn(Storage.prototype, "setItem");
    const sessionSpy = vi.spyOn(Storage.prototype, "setItem");
    const tokens = new AccessTokenStore();
    tokens.set(jwt("memory"));
    expect(localSpy).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
