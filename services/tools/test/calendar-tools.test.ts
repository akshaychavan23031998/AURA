import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarClient } from "../src/providers/google-calendar-client.js";
import { createCalendarTools } from "../src/tools/calendar/events.tool.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";
import { ToolExecutor } from "../src/execution/tool-executor.js";
import { actionDigest } from "../src/execution/action-digest.js";

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
const createInput = {
  summary: "Project discussion",
  start: "2026-08-15T16:00:00+05:30",
  end: "2026-08-15T16:30:00+05:30",
  timezone: "Asia/Kolkata",
  location: "Meeting room 1",
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
      create: vi.fn(),
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

  it("prepares a server-derived WRITE approval without calling Google", () => {
    const client = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
    };
    const registry = new ToolRegistry();
    for (const tool of createCalendarTools(client)) registry.register(tool);
    registry.seal();
    const executor = new ToolExecutor(registry);
    const prepared = executor.prepare(
      "calendar.events.create",
      1,
      createInput,
      {
        actorId: "actor-1",
        grantedPermissions: ["calendar.events.write"],
      },
    );
    expect(prepared).toMatchObject({
      tool: "calendar.events.create",
      approvalPolicy: "REQUIRED",
      title: "Create calendar event",
    });
    expect(prepared.preview).toContain("Project discussion");
    expect(prepared.preview).toContain("Asia/Kolkata");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("requires write permission and an exact trusted approval proof", async () => {
    const client = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn().mockResolvedValue({
        eventId: "created-1",
        title: "Project discussion",
        start: createInput.start,
        end: createInput.end,
        timezone: createInput.timezone,
        status: "confirmed",
      }),
    };
    const registry = new ToolRegistry();
    for (const tool of createCalendarTools(client)) registry.register(tool);
    registry.seal();
    const executor = new ToolExecutor(registry);
    const writeContext = {
      ...context,
      grantedPermissions: ["calendar.events.write"],
    };
    await expect(
      executor.execute({
        tool: "calendar.events.create",
        input: createInput,
        context: writeContext,
      }),
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
    await expect(
      executor.execute({
        tool: "calendar.events.create",
        input: createInput,
        context: {
          ...writeContext,
          grantedPermissions: ["calendar.events.read"],
        },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(client.create).not.toHaveBeenCalled();
  });

  it("POSTs one allowlisted payload only after exact approval and never retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "created-1",
        summary: createInput.summary,
        status: "confirmed",
        start: { dateTime: createInput.start, timeZone: createInput.timezone },
        end: { dateTime: createInput.end, timeZone: createInput.timezone },
        location: createInput.location,
      }),
    );
    const client = createGoogleCalendarClient(fetcher);
    await expect(
      client.create("secret-token-value", createInput, "request-create-1"),
    ).resolves.toMatchObject({ eventId: "created-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect(url instanceof URL ? url.href : "").toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(init?.method).toBe("POST");
    const rawBody = init?.body;
    expect(typeof rawBody).toBe("string");
    expect(JSON.parse(typeof rawBody === "string" ? rawBody : "{}")).toEqual({
      summary: createInput.summary,
      start: { dateTime: createInput.start, timeZone: createInput.timezone },
      end: { dateTime: createInput.end, timeZone: createInput.timezone },
      location: createInput.location,
    });
  });

  it("executes the exact approved create action once and rejects mutation", async () => {
    const client = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn().mockResolvedValue({
        eventId: "created-1",
        title: createInput.summary,
        start: createInput.start,
        end: createInput.end,
        timezone: createInput.timezone,
        status: "confirmed",
      }),
    };
    const registry = new ToolRegistry();
    for (const tool of createCalendarTools(client)) registry.register(tool);
    registry.seal();
    const executor = new ToolExecutor(registry);
    const approvedContext = {
      requestId: "create-approved-1",
      actorId: "actor-1",
      grantedPermissions: ["calendar.events.write"],
      providerAccessToken: "provider-access-token-value",
      approval: {
        status: "approved" as const,
        approvalId: "approval-1",
        approvedActorId: "actor-1",
        approvedTool: "calendar.events.create",
        approvedToolVersion: 1,
        inputDigest: actionDigest("calendar.events.create", 1, createInput),
      },
    };
    await expect(
      executor.execute({
        tool: "calendar.events.create",
        input: createInput,
        context: approvedContext,
      }),
    ).resolves.toMatchObject({ status: "success" });
    expect(client.create).toHaveBeenCalledTimes(1);
    await expect(
      executor.execute({
        tool: "calendar.events.create",
        input: { ...createInput, summary: "Mutated" },
        context: approvedContext,
      }),
    ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous provider failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("connection lost after dispatch"));
    await expect(
      createGoogleCalendarClient(fetcher).create(
        "provider-token-value",
        createInput,
        "request-ambiguous-1",
      ),
    ).rejects.toMatchObject({
      code: "CALENDAR_REQUEST_FAILED",
      message: "Calendar request failed",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid create inputs before provider execution", () => {
    const client = { list: vi.fn(), get: vi.fn(), create: vi.fn() };
    const registry = new ToolRegistry();
    for (const tool of createCalendarTools(client)) registry.register(tool);
    registry.seal();
    const executor = new ToolExecutor(registry);
    for (const invalid of [
      { ...createInput, summary: "" },
      { ...createInput, summary: "x".repeat(201) },
      { ...createInput, timezone: "Not/A_Timezone" },
      { ...createInput, end: createInput.start },
      { ...createInput, end: "2026-08-17T16:30:00+05:30" },
      { ...createInput, attendees: ["attacker@example.com"] },
    ])
      expect(() =>
        executor.prepare("calendar.events.create", 1, invalid, {
          actorId: "actor-1",
          grantedPermissions: ["calendar.events.write"],
        }),
      ).toThrowError(expect.objectContaining({ code: "TOOL_INPUT_INVALID" }));
    expect(client.create).not.toHaveBeenCalled();
  });
});
