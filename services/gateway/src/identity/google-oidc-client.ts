import * as oidc from "openid-client";
import { z } from "zod";

import type { GatewayConfig } from "../config/index.js";
import type { AuthenticatedExternalIdentity } from "./repositories.js";

export interface OidcTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly issuedAt: number;
}

export interface GoogleOidcProvider {
  createAuthorizationUrl(transaction: OidcTransaction): Promise<URL>;
  verifyCallback(
    callbackUrl: URL,
    transaction: OidcTransaction,
  ): Promise<GoogleOidcCallbackResult>;
}

export type GoogleOidcCallbackResult =
  | AuthenticatedExternalIdentity
  | {
      readonly identity: AuthenticatedExternalIdentity;
      readonly refreshToken: string;
      readonly grantedScopes: readonly string[];
    };

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(320).optional(),
  email_verified: z.boolean().optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

export class OpenIdClientGoogleProvider implements GoogleOidcProvider {
  private configuration?: Promise<oidc.Configuration>;

  public constructor(
    private readonly config: Extract<
      GatewayConfig["googleOidc"],
      { enabled: true }
    >,
    configuration?: oidc.Configuration,
    private readonly calendarEnabled = false,
    private readonly gmailEnabled = false,
    private readonly contactsEnabled = false,
  ) {
    if (configuration !== undefined)
      this.configuration = Promise.resolve(configuration);
  }

  public async createAuthorizationUrl(
    transaction: OidcTransaction,
  ): Promise<URL> {
    const configuration = await this.getConfiguration();
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: [
        "openid",
        "email",
        "profile",
        ...(this.calendarEnabled
          ? [
              "https://www.googleapis.com/auth/calendar.readonly",
              "https://www.googleapis.com/auth/calendar.events",
            ]
          : []),
        ...(this.gmailEnabled
          ? [
              "https://www.googleapis.com/auth/gmail.readonly",
              "https://www.googleapis.com/auth/gmail.send",
            ]
          : []),
        ...(this.contactsEnabled
          ? ["https://www.googleapis.com/auth/contacts.readonly"]
          : []),
      ].join(" "),
      ...(this.calendarEnabled || this.gmailEnabled || this.contactsEnabled
        ? { access_type: "offline", prompt: "consent" }
        : {}),
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(
        transaction.codeVerifier,
      ),
      code_challenge_method: "S256",
    });
  }

  public async verifyCallback(
    callbackUrl: URL,
    transaction: OidcTransaction,
  ): Promise<GoogleOidcCallbackResult> {
    const tokens = await oidc.authorizationCodeGrant(
      await this.getConfiguration(),
      callbackUrl,
      {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.codeVerifier,
        idTokenExpected: true,
      },
      { redirect_uri: this.config.redirectUri },
    );
    const parsed = claimsSchema.safeParse(tokens.claims());
    if (!parsed.success) throw new Error("Invalid Google identity response");
    const identity = Object.freeze({
      provider: "google" as const,
      subject: parsed.data.sub,
      emailVerified: parsed.data.email_verified === true,
      ...(parsed.data.email_verified === true && parsed.data.email !== undefined
        ? { email: parsed.data.email }
        : {}),
      ...(parsed.data.name === undefined
        ? {}
        : { displayName: parsed.data.name }),
    });
    if (!this.calendarEnabled && !this.gmailEnabled && !this.contactsEnabled)
      return identity;
    const refreshToken = tokens.refreshToken;
    if (typeof refreshToken !== "string" || refreshToken.length < 16)
      throw new Error("Google did not return an offline credential");
    return Object.freeze({
      identity,
      refreshToken,
      grantedScopes: Object.freeze([
        ...(this.calendarEnabled
          ? [
              "https://www.googleapis.com/auth/calendar.readonly",
              "https://www.googleapis.com/auth/calendar.events",
            ]
          : []),
        ...(this.gmailEnabled
          ? [
              "https://www.googleapis.com/auth/gmail.readonly",
              "https://www.googleapis.com/auth/gmail.send",
            ]
          : []),
        ...(this.contactsEnabled
          ? ["https://www.googleapis.com/auth/contacts.readonly"]
          : []),
      ]),
    });
  }

  private getConfiguration(): Promise<oidc.Configuration> {
    this.configuration ??= oidc
      .discovery(
        new URL("https://accounts.google.com"),
        this.config.clientId,
        this.config.clientSecret,
      )
      .then((configuration) => {
        configuration.timeout = 10;
        return configuration;
      });
    return this.configuration;
  }
}

export function createOidcTransaction(): OidcTransaction {
  return Object.freeze({
    state: oidc.randomState(),
    codeVerifier: oidc.randomPKCECodeVerifier(),
    nonce: oidc.randomNonce(),
    issuedAt: Date.now(),
  });
}
