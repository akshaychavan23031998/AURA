import * as oidc from "openid-client";
import { z } from "zod";

import type { GatewayConfig } from "../config/index.js";
import type { AuthenticatedExternalIdentity } from "./repositories.js";

export interface OidcTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly purpose?: "login" | "reconnect";
  readonly actorId?: string;
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
      readonly refreshToken?: string;
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
      scope: ["openid", "email", "profile", ...this.providerScopes()].join(" "),
      ...(this.calendarEnabled || this.gmailEnabled || this.contactsEnabled
        ? { access_type: "offline", prompt: "consent" }
        : {}),
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(
        transaction.codeVerifier,
      ),
      code_challenge_method: "S256",
      include_granted_scopes: "true",
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
    return Object.freeze({
      identity,
      ...(typeof refreshToken === "string" && refreshToken.length >= 16
        ? { refreshToken }
        : {}),
      grantedScopes: Object.freeze(
        typeof tokens.scope === "string"
          ? tokens.scope
              .split(" ")
              .filter((scope) => this.providerScopes().includes(scope))
          : this.providerScopes(),
      ),
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

  private providerScopes(): string[] {
    return [
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
    ];
  }
}

export function createOidcTransaction(
  binding?: Readonly<{ purpose: "reconnect"; actorId: string }>,
): OidcTransaction {
  return Object.freeze({
    state: oidc.randomState(),
    codeVerifier: oidc.randomPKCECodeVerifier(),
    nonce: oidc.randomNonce(),
    issuedAt: Date.now(),
    ...(binding ?? { purpose: "login" as const }),
  });
}
