import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoogleIntegrationPanel } from "./google-integration-panel";

function api(linked = true) {
  return {
    status: vi.fn().mockResolvedValue({
      provider: "google" as const,
      linked,
      capabilities: [
        { id: "calendar.read" as const, status: "granted" as const },
        { id: "gmail.send" as const, status: "reauth_required" as const },
      ],
    }),
    reconnect: vi
      .fn()
      .mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth"),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GoogleIntegrationPanel", () => {
  it("renders connected and missing capabilities without tokens", async () => {
    const integration = api();
    render(<GoogleIntegrationPanel api={integration} />);
    expect(await screen.findByText("Calendar read")).toBeVisible();
    expect(screen.getByText("Gmail send")).toBeVisible();
    expect(screen.getByText("Needs permission")).toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /access.?token|refresh.?token/i,
    );
    expect(integration.reconnect).not.toHaveBeenCalled();
  });

  it("starts re-consent only after an explicit click", async () => {
    const integration = api();
    integration.reconnect.mockReturnValueOnce(new Promise(() => undefined));
    render(<GoogleIntegrationPanel api={integration} />);
    const button = await screen.findByRole("button", {
      name: "Reconnect Google",
    });
    expect(integration.reconnect).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(integration.reconnect).toHaveBeenCalledOnce());
  });

  it("shows a sanitized reconnect failure", async () => {
    const integration = api();
    integration.reconnect.mockRejectedValueOnce(new Error("private token"));
    render(<GoogleIntegrationPanel api={integration} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Reconnect Google" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Google reconnect could not be started",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("private token");
  });

  it("disconnects provider access while leaving AURA logout separate", async () => {
    const integration = api();
    render(<GoogleIntegrationPanel api={integration} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect Google" }),
    );
    await waitFor(() => expect(integration.disconnect).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: /log out/i }),
    ).not.toBeInTheDocument();
  });
});
