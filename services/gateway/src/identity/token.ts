import { createHash, randomBytes } from "node:crypto";

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}
