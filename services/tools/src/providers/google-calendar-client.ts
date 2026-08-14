import { z } from "zod";
import { ToolError } from "../errors/tool-error.js";

const GOOGLE_CALENDAR_ORIGIN = "https://www.googleapis.com";
const eventSchema = z
  .object({
    id: z.string().min(1).max(1024),
    summary: z.string().max(4096).optional(),
    status: z.string().max(64).optional(),
    location: z.string().max(4096).optional(),
    start: z
      .object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      })
      .passthrough(),
    end: z
      .object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const listSchema = z
  .object({ items: z.array(eventSchema).max(50).optional() })
  .passthrough();
export interface CalendarEvent {
  eventId: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
  status: string;
  location?: string;
}
export interface GoogleCalendarClient {
  list(
    accessToken: string,
    input: { timeMin: string; timeMax: string; maxResults: number },
    requestId: string,
  ): Promise<CalendarEvent[]>;
  get(
    accessToken: string,
    eventId: string,
    requestId: string,
  ): Promise<CalendarEvent>;
  create(
    accessToken: string,
    input: CalendarCreateInput,
    requestId: string,
  ): Promise<CalendarEvent>;
  update(
    accessToken: string,
    input: CalendarUpdateInput,
    requestId: string,
  ): Promise<CalendarEvent>;
  delete(
    accessToken: string,
    eventId: string,
    requestId: string,
  ): Promise<void>;
}
export interface CalendarUpdateInput {
  readonly eventId: string;
  readonly summary?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly timezone?: string | undefined;
  readonly location?: string | undefined;
}
export interface CalendarCreateInput {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly location?: string | undefined;
}
export function createGoogleCalendarClient(
  fetcher: typeof fetch = fetch,
): GoogleCalendarClient {
  const request = async (
    url: URL,
    token: string,
    requestId: string,
    init: Pick<RequestInit, "method" | "body"> = {},
  ) => {
    if (url.origin !== GOOGLE_CALENDAR_ORIGIN)
      throw new Error("Invalid Calendar origin");
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": requestId,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ToolError(
        "CALENDAR_REQUEST_FAILED",
        502,
        "Calendar request failed",
        { cause: error },
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ToolError(
        "PROVIDER_REAUTH_REQUIRED",
        409,
        "Google Calendar reconnection is required",
      );
    if (response.status === 429)
      throw new ToolError(
        "CALENDAR_RATE_LIMITED",
        429,
        "Google Calendar rate limit reached",
      );
    if (!response.ok)
      throw new ToolError(
        "CALENDAR_REQUEST_FAILED",
        502,
        "Calendar request failed",
      );
    return response.status === 204 ? undefined : response.json();
  };
  return {
    async list(token, input, requestId) {
      const url = new URL(
        "/calendar/v3/calendars/primary/events",
        GOOGLE_CALENDAR_ORIGIN,
      );
      url.searchParams.set("timeMin", input.timeMin);
      url.searchParams.set("timeMax", input.timeMax);
      url.searchParams.set("maxResults", String(input.maxResults));
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      const parsed = listSchema.safeParse(await request(url, token, requestId));
      if (!parsed.success)
        throw new ToolError(
          "CALENDAR_REQUEST_FAILED",
          502,
          "Calendar returned invalid data",
        );
      return (parsed.data.items ?? []).map(normalizeEvent);
    },
    async get(token, eventId, requestId) {
      const url = new URL(
        `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        GOOGLE_CALENDAR_ORIGIN,
      );
      const parsed = eventSchema.safeParse(
        await request(url, token, requestId),
      );
      if (!parsed.success)
        throw new ToolError(
          "CALENDAR_REQUEST_FAILED",
          502,
          "Calendar returned invalid data",
        );
      return normalizeEvent(parsed.data);
    },
    async create(token, input, requestId) {
      const url = new URL(
        "/calendar/v3/calendars/primary/events",
        GOOGLE_CALENDAR_ORIGIN,
      );
      const payload = {
        summary: input.summary,
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
        ...(input.location === undefined ? {} : { location: input.location }),
      };
      const parsed = eventSchema.safeParse(
        await request(url, token, requestId, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );
      if (!parsed.success)
        throw new ToolError(
          "CALENDAR_REQUEST_FAILED",
          502,
          "Calendar returned invalid data",
        );
      return normalizeEvent(parsed.data);
    },
    async update(token, input, requestId) {
      const url = eventUrl(input.eventId);
      const payload = {
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.start === undefined || input.timezone === undefined
          ? {}
          : {
              start: { dateTime: input.start, timeZone: input.timezone },
            }),
        ...(input.end === undefined || input.timezone === undefined
          ? {}
          : { end: { dateTime: input.end, timeZone: input.timezone } }),
        ...(input.location === undefined ? {} : { location: input.location }),
      };
      const parsed = eventSchema.safeParse(
        await request(url, token, requestId, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      );
      if (!parsed.success)
        throw new ToolError(
          "CALENDAR_REQUEST_FAILED",
          502,
          "Calendar returned invalid data",
        );
      return normalizeEvent(parsed.data);
    },
    async delete(token, eventId, requestId) {
      await request(eventUrl(eventId), token, requestId, { method: "DELETE" });
    },
  };
}

function eventUrl(eventId: string): URL {
  return new URL(
    `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    GOOGLE_CALENDAR_ORIGIN,
  );
}
function normalizeEvent(event: z.infer<typeof eventSchema>): CalendarEvent {
  const start = event.start.dateTime ?? event.start.date;
  const end = event.end.dateTime ?? event.end.date;
  if (start === undefined || end === undefined)
    throw new ToolError(
      "CALENDAR_REQUEST_FAILED",
      502,
      "Calendar returned invalid data",
    );
  return {
    eventId: event.id,
    title: event.summary ?? "Untitled event",
    start,
    end,
    status: event.status ?? "confirmed",
    ...(event.start.timeZone === undefined
      ? {}
      : { timezone: event.start.timeZone }),
    ...(event.location === undefined ? {} : { location: event.location }),
  };
}
