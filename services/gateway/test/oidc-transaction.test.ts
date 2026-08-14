import { describe, expect, it } from "vitest";
import { OidcTransactionCodec } from "../src/identity/oidc-transaction.js";

const transaction = {
  state: "s".repeat(32),
  codeVerifier: "v".repeat(43),
  nonce: "n".repeat(32),
  issuedAt: 1_000_000,
};

describe("OIDC transaction codec", () => {
  it("round-trips an encrypted transaction only within its lifetime", () => {
    const codec = new OidcTransactionCodec(
      "secret-at-least-32-characters-long",
      600,
    );
    const encoded = codec.encode(transaction);
    expect(encoded).not.toContain(transaction.state);
    expect(encoded).not.toContain(transaction.codeVerifier);
    expect(codec.decode(encoded, transaction.issuedAt + 599_000)).toEqual(
      transaction,
    );
    expect(
      codec.decode(encoded, transaction.issuedAt + 601_000),
    ).toBeUndefined();
  });

  it("rejects tampering and a different encryption key", () => {
    const codec = new OidcTransactionCodec(
      "secret-at-least-32-characters-long",
      600,
    );
    const encoded = codec.encode(transaction);
    const tampered = `${encoded[0] === "A" ? "B" : "A"}${encoded.slice(1)}`;
    expect(codec.decode(tampered, transaction.issuedAt)).toBeUndefined();
    expect(
      new OidcTransactionCodec(
        "different-secret-at-least-32-chars",
        600,
      ).decode(encoded, transaction.issuedAt),
    ).toBeUndefined();
  });
});
