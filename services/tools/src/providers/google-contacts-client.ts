import { z } from "zod";
import { ToolError } from "../errors/tool-error.js";

const ORIGIN = "https://people.googleapis.com";
const resourceNameSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^people\/[A-Za-z0-9_-]+$/);
const field = z
  .object({
    value: z.string().min(1).max(500),
    type: z.string().max(100).optional(),
  })
  .passthrough();
const person = z
  .object({
    resourceName: resourceNameSchema,
    names: z
      .array(z.object({ displayName: z.string().max(500) }).passthrough())
      .max(10)
      .optional(),
    emailAddresses: z.array(field).max(20).optional(),
    phoneNumbers: z.array(field).max(20).optional(),
  })
  .passthrough();
const connections = z
  .object({ connections: z.array(person).max(25).optional() })
  .passthrough();
export interface Contact {
  readonly resourceName: string;
  readonly displayName: string;
  readonly emailAddresses: readonly { value: string; type?: string }[];
  readonly phoneNumbers: readonly { value: string; type?: string }[];
}
export interface GoogleContactsClient {
  list(
    token: string,
    maxResults: number,
    requestId: string,
  ): Promise<Contact[]>;
  get(token: string, resourceName: string, requestId: string): Promise<Contact>;
}
export function createGoogleContactsClient(
  fetcher: typeof fetch = fetch,
): GoogleContactsClient {
  const request = async (url: URL, token: string, requestId: string) => {
    if (url.origin !== ORIGIN) throw new Error("Invalid People API origin");
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": requestId,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ToolError(
        "CONTACTS_REQUEST_FAILED",
        502,
        "Contacts request failed",
        { cause: error },
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ToolError(
        "PROVIDER_REAUTH_REQUIRED",
        409,
        "Google Contacts reconnection is required",
      );
    if (response.status === 429)
      throw new ToolError(
        "CONTACTS_RATE_LIMITED",
        429,
        "Google Contacts rate limit reached",
      );
    if (!response.ok)
      throw new ToolError(
        "CONTACTS_REQUEST_FAILED",
        502,
        "Contacts request failed",
      );
    return response.json();
  };
  const normalize = (p: z.infer<typeof person>): Contact => {
    const map = (items: z.infer<typeof field>[] | undefined) =>
      (items ?? []).map(({ value, type }) => ({
        value,
        ...(type === undefined ? {} : { type }),
      }));
    return {
      resourceName: p.resourceName,
      displayName: p.names?.[0]?.displayName ?? "",
      emailAddresses: map(p.emailAddresses),
      phoneNumbers: map(p.phoneNumbers),
    };
  };
  return {
    async list(token, maxResults, id) {
      const url = new URL("/v1/people/me/connections", ORIGIN);
      url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers");
      url.searchParams.set("pageSize", String(maxResults));
      const parsed = connections.safeParse(await request(url, token, id));
      if (!parsed.success)
        throw new ToolError(
          "CONTACTS_REQUEST_FAILED",
          502,
          "Contacts returned invalid data",
        );
      return (parsed.data.connections ?? []).map(normalize);
    },
    async get(token, resourceName, id) {
      const validatedResourceName = resourceNameSchema.safeParse(resourceName);
      if (!validatedResourceName.success)
        throw new ToolError(
          "TOOL_INPUT_INVALID",
          400,
          "Contact resource name is invalid",
        );
      const url = new URL(`/v1/${validatedResourceName.data}`, ORIGIN);
      url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers");
      const parsed = person.safeParse(await request(url, token, id));
      if (!parsed.success)
        throw new ToolError(
          "CONTACTS_REQUEST_FAILED",
          502,
          "Contacts returned invalid data",
        );
      return normalize(parsed.data);
    },
  };
}
