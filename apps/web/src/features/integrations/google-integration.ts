import { z } from "zod";
import { resolveGatewayHttpUrl } from "../voice/gateway-url";
import type { AuthenticatedFetch } from "../auth/authenticated-fetch";

export const googleCapabilityIdSchema = z.enum([
  "calendar.read",
  "calendar.write",
  "gmail.read",
  "gmail.send",
  "contacts.read",
]);
const statusSchema = z
  .object({
    provider: z.literal("google"),
    linked: z.boolean(),
    capabilities: z.array(
      z
        .object({
          id: googleCapabilityIdSchema,
          status: z.enum(["granted", "reauth_required"]),
        })
        .strict(),
    ),
  })
  .strict();
const reconnectSchema = z.object({ authorizationUrl: z.url() }).strict();

export type GoogleIntegrationStatus = z.infer<typeof statusSchema>;

export class GoogleIntegrationApi {
  public constructor(
    private readonly http: Pick<AuthenticatedFetch, "request">,
    private readonly baseUrl: URL = resolveGatewayHttpUrl(),
  ) {}

  public async status(): Promise<GoogleIntegrationStatus> {
    const response = await this.http.request(
      new URL("api/v1/integrations/google", this.baseUrl),
    );
    const parsed = statusSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid Google integration response");
    return parsed.data;
  }

  public async reconnect(): Promise<string> {
    const response = await this.http.request(
      new URL("api/v1/integrations/google/reconnect", this.baseUrl),
      { method: "POST" },
    );
    const parsed = reconnectSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid Google reconnect response");
    const authorizationUrl = new URL(parsed.data.authorizationUrl);
    if (authorizationUrl.origin !== "https://accounts.google.com")
      throw new Error("Invalid Google authorization origin");
    return authorizationUrl.href;
  }

  public async disconnect(): Promise<void> {
    await this.http.request(
      new URL("api/v1/integrations/google/disconnect", this.baseUrl),
      { method: "POST" },
    );
  }
}

export const CAPABILITY_LABELS = Object.freeze({
  "calendar.read": "Calendar read",
  "calendar.write": "Calendar changes",
  "gmail.read": "Gmail read",
  "gmail.send": "Gmail send",
  "contacts.read": "Contacts read",
});
