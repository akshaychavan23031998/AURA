import { describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../src/execution/tool-executor.js";
import { createGoogleContactsClient } from "../src/providers/google-contacts-client.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import { createContactsTools } from "../src/tools/contacts/people.tool.js";
const context = {
  requestId: "contacts-request",
  actorId: "actor",
  grantedPermissions: ["contacts.people.read"],
  providerAccessToken: "provider-token",
};
const person = {
  resourceName: "people/c123",
  names: [{ displayName: "Alice" }],
  emailAddresses: [{ value: "alice@example.com", type: "work" }],
  phoneNumbers: [{ value: "+911234" }],
  photos: [{ url: "private" }],
};
function registry(client: Parameters<typeof createContactsTools>[0]) {
  const result = new ToolRegistry();
  for (const tool of createContactsTools(client)) result.register(tool);
  result.seal();
  return result;
}
describe("Google Contacts read tools", () => {
  it("defines exact read-only metadata", () =>
    expect(registry(createGoogleContactsClient()).listMetadata()).toEqual([
      expect.objectContaining({
        name: "contacts.people.get",
        riskLevel: "READ",
        approvalPolicy: "NONE",
        requiredPermissions: ["contacts.people.read"],
      }),
      expect.objectContaining({
        name: "contacts.people.list",
        riskLevel: "READ",
        approvalPolicy: "NONE",
        requiredPermissions: ["contacts.people.read"],
      }),
    ]));
  it("uses fixed GET endpoints and normalized results", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ connections: [person] }));
    const result = await createGoogleContactsClient(fetcher).list(
      "secret",
      10,
      "req-1",
    );
    expect(result[0]).toEqual({
      resourceName: "people/c123",
      displayName: "Alice",
      emailAddresses: [{ value: "alice@example.com", type: "work" }],
      phoneNumbers: [{ value: "+911234" }],
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect(url instanceof URL ? url.origin : "").toBe(
      "https://people.googleapis.com",
    );
    expect(url instanceof URL ? url.pathname : "").toBe(
      "/v1/people/me/connections",
    );
    expect(url instanceof URL ? url.searchParams.get("personFields") : "").toBe(
      "names,emailAddresses,phoneNumbers",
    );
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ "x-request-id": "req-1" });

    fetcher.mockResolvedValueOnce(Response.json(person));
    await expect(
      createGoogleContactsClient(fetcher).get("secret", "people/c123", "req-2"),
    ).resolves.toMatchObject({ resourceName: "people/c123" });
    const [getUrl, getInit] = fetcher.mock.calls[1] ?? [];
    expect(getUrl instanceof URL ? getUrl.href : "").toBe(
      "https://people.googleapis.com/v1/people/c123?personFields=names%2CemailAddresses%2CphoneNumbers",
    );
    expect(getInit?.method).toBe("GET");
    expect(getInit?.headers).toMatchObject({ "x-request-id": "req-2" });
  });
  it("rejects invalid identifiers, fields, bounds, permissions, and token injection", async () => {
    const client = { list: vi.fn().mockResolvedValue([]), get: vi.fn() };
    const executor = new ToolExecutor(registry(client));
    for (const input of [
      { resourceName: "https://evil.test/x" },
      { resourceName: "people/../x" },
      { resourceName: "people/c123", url: "https://evil.test" },
    ])
      await expect(
        executor.execute({ tool: "contacts.people.get", input, context }),
      ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      executor.execute({
        tool: "contacts.people.list",
        input: { maxResults: 26 },
        context,
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      executor.execute({
        tool: "contacts.people.list",
        input: { maxResults: 10 },
        context: { ...context, grantedPermissions: ["gmail.messages.read"] },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      executor.execute({
        tool: "contacts.people.list",
        input: { maxResults: 10, providerAccessToken: "x" },
        context,
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      createGoogleContactsClient(vi.fn<typeof fetch>()).get(
        "secret",
        "people/../x",
        "req",
      ),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
  });
  it.each([
    [401, "PROVIDER_REAUTH_REQUIRED"],
    [403, "PROVIDER_REAUTH_REQUIRED"],
    [429, "CONTACTS_RATE_LIMITED"],
    [500, "CONTACTS_REQUEST_FAILED"],
  ])("sanitizes provider %i", async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private", { status }));
    await expect(
      createGoogleContactsClient(fetcher).list("secret", 10, "req"),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
