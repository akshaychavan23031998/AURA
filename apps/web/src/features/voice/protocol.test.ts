import { describe, expect, it } from "vitest";
import { parseVoiceEvent, transitionForEvent } from "./protocol";

const base = {
  protocol: "aura.voice.v1",
  sessionId: "00000000-0000-4000-8000-000000000001",
  requestId: "request",
} as const;
describe("voice protocol", () => {
  it("accepts known strict events and derives state", () => {
    const event = parseVoiceEvent({
      ...base,
      type: "speech.started",
      turnId: "00000000-0000-4000-8000-000000000002",
    });
    expect(event).toBeDefined();
    expect(transitionForEvent(event!)).toMatchObject({ status: "listening" });
  });
  it("rejects unknown, malformed, and privilege-bearing events", () => {
    expect(parseVoiceEvent({ ...base, type: "future.event" })).toBeUndefined();
    expect(
      parseVoiceEvent({
        ...base,
        type: "session.ready",
        permissions: ["admin"],
      }),
    ).toBeUndefined();
  });
  it("maps interruption and session expiry safely", () => {
    expect(
      transitionForEvent(
        parseVoiceEvent({ ...base, type: "turn.interrupted" })!,
      ).status,
    ).toBe("interrupting");
    expect(
      transitionForEvent(
        parseVoiceEvent({
          ...base,
          type: "error",
          payload: { code: "UNAUTHENTICATED" },
        })!,
      ).error,
    ).toMatch(/expired/i);
  });
  it("derives approval state only from the server protocol event", () => {
    const event = parseVoiceEvent({
      ...base,
      type: "approval.required",
      turnId: "00000000-0000-4000-8000-000000000002",
      payload: {
        approvalId: "00000000-0000-4000-8000-000000000003",
        title: "Confirm action",
        preview: "Run safe test action",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(transitionForEvent(event!)).toMatchObject({
      status: "awaiting-approval",
    });
    expect(
      transitionForEvent(parseVoiceEvent({ ...base, type: "speech.started" })!)
        .status,
    ).toBe("listening");
  });
});
