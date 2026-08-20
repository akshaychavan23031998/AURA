import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

import type { OidcTransaction } from "./google-oidc-client.js";

const transactionSchema = z
  .object({
    state: z.string().min(32).max(256),
    codeVerifier: z.string().min(43).max(128),
    nonce: z.string().min(32).max(256),
    issuedAt: z.number().int().positive(),
    purpose: z.enum(["login", "reconnect"]).optional(),
    actorId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.purpose === "reconnect" && value.actorId === undefined)
      context.addIssue({ code: "custom", message: "Reconnect actor required" });
    if (value.purpose !== "reconnect" && value.actorId !== undefined)
      context.addIssue({ code: "custom", message: "Unexpected actor binding" });
  });
const CONTEXT = "aura:google-oidc-transaction:v1";

export class OidcTransactionCodec {
  private readonly key: Buffer;

  public constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = createHash("sha256").update(CONTEXT).update(secret).digest();
  }

  public encode(transaction: OidcTransaction): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(CONTEXT));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(transaction), "utf8"),
      cipher.final(),
    ]);
    return [iv, ciphertext, cipher.getAuthTag()]
      .map((part) => part.toString("base64url"))
      .join(".");
  }

  public decode(value: string, now = Date.now()): OidcTransaction | undefined {
    if (value.length > 2_048) return undefined;
    try {
      const parts = value.split(".");
      if (parts.length !== 3) return undefined;
      const [ivValue, ciphertextValue, tagValue] = parts;
      if (
        ivValue === undefined ||
        ciphertextValue === undefined ||
        tagValue === undefined
      )
        return undefined;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(ivValue, "base64url"),
      );
      decipher.setAAD(Buffer.from(CONTEXT));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      const parsed = transactionSchema.safeParse(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(ciphertextValue, "base64url")),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
      if (!parsed.success) return undefined;
      const age = now - parsed.data.issuedAt;
      if (age < 0 || age > this.ttlSeconds * 1_000) return undefined;
      return Object.freeze({
        state: parsed.data.state,
        codeVerifier: parsed.data.codeVerifier,
        nonce: parsed.data.nonce,
        issuedAt: parsed.data.issuedAt,
        ...(parsed.data.purpose === undefined
          ? {}
          : { purpose: parsed.data.purpose }),
        ...(parsed.data.actorId === undefined
          ? {}
          : { actorId: parsed.data.actorId }),
      });
    } catch {
      return undefined;
    }
  }
}
