import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { externalIdentities, providerCredentials } from "../db/schema.js";
import { AppError } from "../errors/app-error.js";

export const GOOGLE_CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_GMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const tokenSchema = z
  .object({ access_token: z.string().min(16).max(4096) })
  .passthrough();

export class ProviderCredentialRepository {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly encryptionKey: Buffer,
  ) {}

  public async storeGoogle(
    userId: string,
    providerSubject: string,
    refreshToken: string,
    scopes: readonly string[],
  ): Promise<void> {
    const [binding] = await this.database.db
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.userId, userId),
          eq(externalIdentities.provider, "google"),
          eq(externalIdentities.providerSubject, providerSubject),
        ),
      )
      .limit(1);
    if (binding === undefined)
      throw new Error("Google identity binding mismatch");
    await this.database.db
      .insert(providerCredentials)
      .values({
        userId,
        provider: "google",
        providerSubject,
        encryptedRefreshToken: encrypt(refreshToken, this.encryptionKey),
        grantedScopes: [...scopes],
      })
      .onConflictDoUpdate({
        target: [providerCredentials.userId, providerCredentials.provider],
        set: {
          providerSubject,
          encryptedRefreshToken: encrypt(refreshToken, this.encryptionKey),
          grantedScopes: [...scopes],
          updatedAt: new Date(),
        },
      });
  }

  public async getGoogle(userId: string) {
    const [row] = await this.database.db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.userId, userId),
          eq(providerCredentials.provider, "google"),
        ),
      )
      .limit(1);
    if (row === undefined) return undefined;
    return {
      subject: row.providerSubject,
      refreshToken: decrypt(row.encryptedRefreshToken, this.encryptionKey),
      scopes: Object.freeze([...row.grantedScopes]),
    };
  }
}

export class GoogleProviderAccessTokenService {
  public constructor(
    private readonly credentials: Pick<
      ProviderCredentialRepository,
      "getGoogle"
    >,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  public async getAccessToken(
    actorId: string,
    requiredScope = GOOGLE_CALENDAR_READ_SCOPE,
  ): Promise<string> {
    const credential = await this.credentials.getGoogle(actorId);
    if (credential === undefined || !credential.scopes.includes(requiredScope))
      throw reauth();
    let response: Response;
    try {
      response = await this.fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: credential.refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw reauth();
    }
    if (!response.ok) throw reauth();
    const parsed = tokenSchema.safeParse(await response.json());
    if (!parsed.success) throw reauth();
    return parsed.data.access_token;
  }
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}
function decrypt(value: string, key: Buffer): string {
  const [iv, tag, ciphertext] = value.split(".");
  if (iv === undefined || tag === undefined || ciphertext === undefined)
    throw reauth();
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw reauth();
  }
}
function reauth(): AppError {
  return new AppError({
    code: "PROVIDER_REAUTH_REQUIRED",
    httpStatus: 409,
    message: "Google Calendar connection is required",
  });
}
