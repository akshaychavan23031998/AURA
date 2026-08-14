import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarClient } from "../src/providers/google-calendar-client.js";
import { createCalendarTools } from "../src/tools/calendar/events.tool.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import { ToolExecutor } from "../src/execution/tool-executor.js";

const input = {
  timeMin: "2026-08-14T00:00:00Z",
  timeMax: "2026-08-15T00:00:00Z",
  maxResults: 10,
};
const context = {
  requestId: "calendar-request-1",
  actorId: "actor-1",
  grantedPermissions: ["calendar.events.read"],
  providerAccessToken: "provider-access-token-value",
};

describe("Google Calendar tools", () => {
  it("calls only the fixed Google host and normalizes list results", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [
          {
            id: "event-1",
            summary: "Design review",
            status: "confirmed",
            start: { dateTime: "2026-08-14T10:00:00Z", timeZone: "UTC" },
            end: { dateTime: "2026-08-14T10:30:00Z", timeZone: "UTC" },
          },
        ],
      }),
    );
    const client = createGoogleCalendarClient(fetcher);
    await expect(
      client.list("secret-token-value", input, "request-1"),
    ).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", title: "Design review" }),
    ]);
    const url = fetcher.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    const href = url instanceof URL ? url.href : "";
    expect(href).toMatch(
      /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events/,
    );
    expect(href).not.toContain("secret-token-value");
  });

  it("fails with sanitized reauth and provider errors", async () => {
    await expect(
      createGoogleCalendarClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("token detail", { status: 401 })),
      ).list("invalid-provider-token", input, "request-1"),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    await expect(
      createGoogleCalendarClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("private provider body", { status: 500 }),
          ),
      ).list("provider-token-value", input, "request-1"),
    ).rejects.toMatchObject({
      code: "CALENDAR_REQUEST_FAILED",
      message: "Calendar request failed",
    });
  });

  it("enforces strict bounds, permissions, and provider credentials", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
    };
    const registry = new ToolRegistry();
    for (const tool of createCalendarTools(client)) registry.register(tool);
    registry.seal();
    const executor = new ToolExecutor(registry);
    await expect(
      executor.execute({
        tool: "calendar.events.list",
        version: 1,
        input,
        context,
      }),
    ).resolves.toMatchObject({ status: "success" });
    for (const invalid of [
      { ...input, maxResults: 51 },
      { ...input, timeMax: "2027-01-01T00:00:00Z" },
      { ...input, injected: true },
    ])
      await expect(
        executor.execute({
          tool: "calendar.events.list",
          version: 1,
          input: invalid,
          context,
        }),
      ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(
      executor.execute({
        tool: "calendar.events.list",
        version: 1,
        input,
        context: { ...context, grantedPermissions: [] },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      executor.execute({
        tool: "calendar.events.list",
        version: 1,
        input,
        context: {
          requestId: context.requestId,
          actorId: context.actorId,
          grantedPermissions: context.grantedPermissions,
        },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
  });
});
