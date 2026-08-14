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
      update: vi.fn(),
      delete: vi.fn(),
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
      update: vi.fn(),
      delete: vi.fn(),
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
      update: vi.fn(),
      delete: vi.fn(),
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
      update: vi.fn(),
      delete: vi.fn(),
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
    const client = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
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

  it("defines update and delete with authoritative write policies", () => {
    const registry = new ToolRegistry();
    for (const tool of createCalendarTools(createGoogleCalendarClient()))
      registry.register(tool);
    registry.seal();
    expect(registry.listMetadata()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "calendar.events.update",
          riskLevel: "WRITE",
          approvalPolicy: "REQUIRED",
          idempotency: "NON_IDEMPOTENT",
          requiredPermissions: ["calendar.events.write"],
        }),
        expect.objectContaining({
          name: "calendar.events.delete",
          riskLevel: "DESTRUCTIVE",
          approvalPolicy: "REQUIRED",
          idempotency: "NON_IDEMPOTENT",
          requiredPermissions: ["calendar.events.write"],
        }),
      ]),
    );
  });

  it("prepares safe mutation previews without provider calls", () => {
    const client = mutationClient();
    const executor = calendarExecutor(client);
    const update = executor.prepare(
      "calendar.events.update",
      1,
      { eventId: "event-1", summary: "Project review" },
      writePreparationContext,
    );
    expect(update.approvalPolicy).toBe("REQUIRED");
    expect(update.preview).toContain("New title: Project review");
    const deletion = executor.prepare(
      "calendar.events.delete",
      1,
      { eventId: "event-1" },
      writePreparationContext,
    );
    expect(deletion.approvalPolicy).toBe("REQUIRED");
    expect(deletion.preview).toContain("This will remove the event");
    expect(client.update).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("rejects unsafe update and delete inputs before mutation", () => {
    const client = mutationClient();
    const executor = calendarExecutor(client);
    for (const invalid of [
      { eventId: "event-1" },
      { eventId: "", summary: "Title" },
      {
        eventId: "event-1",
        timezone: "Invalid/Timezone",
        start: createInput.start,
        end: createInput.end,
      },
      { eventId: "event-1", start: createInput.start },
      {
        eventId: "event-1",
        start: createInput.end,
        end: createInput.start,
        timezone: createInput.timezone,
      },
      {
        eventId: "event-1",
        start: createInput.start,
        end: "2026-08-17T16:30:00+05:30",
        timezone: createInput.timezone,
      },
      { eventId: "event-1", summary: "Title", attendees: [] },
    ])
      expect(() =>
        executor.prepare(
          "calendar.events.update",
          1,
          invalid,
          writePreparationContext,
        ),
      ).toThrowError(expect.objectContaining({ code: "TOOL_INPUT_INVALID" }));
    for (const invalid of [
      {},
      { eventId: "" },
      { eventId: "event-1", calendarId: "other" },
    ])
      expect(() =>
        executor.prepare(
          "calendar.events.delete",
          1,
          invalid,
          writePreparationContext,
        ),
      ).toThrowError(expect.objectContaining({ code: "TOOL_INPUT_INVALID" }));
    expect(client.update).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("requires write permission and approval for both mutations", async () => {
    const client = mutationClient();
    const executor = calendarExecutor(client);
    for (const [tool, input] of [
      ["calendar.events.update", { eventId: "event-1", summary: "New" }],
      ["calendar.events.delete", { eventId: "event-1" }],
    ] as const) {
      expect(() =>
        executor.prepare(tool, 1, input, {
          actorId: "actor-1",
          grantedPermissions: ["calendar.events.read"],
        }),
      ).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
      await expect(
        executor.execute({
          tool,
          input,
          context: {
            ...context,
            grantedPermissions: ["calendar.events.write"],
          },
        }),
      ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
    }
    expect(client.update).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("executes each exact approved mutation and rejects changed input", async () => {
    const client = mutationClient();
    client.update.mockResolvedValue({
      eventId: "event-1",
      title: "New title",
      start: createInput.start,
      end: createInput.end,
      status: "confirmed",
    });
    client.delete.mockResolvedValue(undefined);
    const executor = calendarExecutor(client);
    for (const [tool, input] of [
      ["calendar.events.update", { eventId: "event-1", summary: "New title" }],
      ["calendar.events.delete", { eventId: "event-2" }],
    ] as const) {
      const approvedContext = {
        requestId: `approved-${tool}`,
        actorId: "actor-1",
        grantedPermissions: ["calendar.events.write"],
        providerAccessToken: "provider-access-token",
        approval: {
          status: "approved" as const,
          approvalId: `approval-${tool}`,
          approvedActorId: "actor-1",
          approvedTool: tool,
          approvedToolVersion: 1,
          inputDigest: actionDigest(tool, 1, input),
        },
      };
      await expect(
        executor.execute({ tool, input, context: approvedContext }),
      ).resolves.toMatchObject({ status: "success", tool });
      await expect(
        executor.execute({
          tool,
          input: { ...input, eventId: "mutated-event" },
          context: approvedContext,
        }),
      ).rejects.toMatchObject({ code: "TOOL_APPROVAL_REQUIRED" });
    }
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.delete).toHaveBeenCalledTimes(1);
  });

  it("uses fixed encoded PATCH and DELETE endpoints with allowlisted payloads", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: "event/one",
          summary: "Project review",
          status: "confirmed",
          start: {
            dateTime: createInput.start,
            timeZone: createInput.timezone,
          },
          end: { dateTime: createInput.end, timeZone: createInput.timezone },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createGoogleCalendarClient(fetcher);
    await client.update(
      "provider-token",
      { eventId: "event/one", summary: "Project review" },
      "request-update-1",
    );
    await client.delete("provider-token", "event/one", "request-delete-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const updateUrl = fetcher.mock.calls[0]?.[0];
    expect(updateUrl).toBeInstanceOf(URL);
    expect(updateUrl instanceof URL ? updateUrl.href : "").toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event%2Fone",
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
    const updateBody = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof updateBody).toBe("string");
    expect(
      JSON.parse(typeof updateBody === "string" ? updateBody : "{}"),
    ).toEqual({
      summary: "Project review",
    });
    const deleteUrl = fetcher.mock.calls[1]?.[0];
    expect(deleteUrl).toBeInstanceOf(URL);
    expect(deleteUrl instanceof URL ? deleteUrl.href : "").toContain(
      "event%2Fone",
    );
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it.each(["update", "delete"] as const)(
    "does not retry an ambiguous %s outcome",
    async (operation) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("response lost"));
      const client = createGoogleCalendarClient(fetcher);
      const result =
        operation === "update"
          ? client.update(
              "provider-token",
              { eventId: "event-1", summary: "New" },
              "request-1",
            )
          : client.delete("provider-token", "event-1", "request-1");
      await expect(result).rejects.toMatchObject({
        code: "CALENDAR_REQUEST_FAILED",
        message: "Calendar request failed",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});

const writePreparationContext = {
  actorId: "actor-1",
  grantedPermissions: ["calendar.events.write"],
};

function mutationClient() {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function calendarExecutor(client: ReturnType<typeof mutationClient>) {
  const registry = new ToolRegistry();
  for (const tool of createCalendarTools(client)) registry.register(tool);
  registry.seal();
  return new ToolExecutor(registry);
}
