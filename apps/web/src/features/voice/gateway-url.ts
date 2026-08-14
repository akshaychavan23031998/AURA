export function resolveVoiceWebSocketUrl(
  location: Location = window.location,
): string {
  const configured = process.env.NEXT_PUBLIC_GATEWAY_URL;
  const base =
    configured === undefined || configured === ""
      ? `${location.protocol}//${location.hostname}:4000`
      : configured;
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Invalid Gateway URL");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/voice/session";
  url.search = "";
  url.hash = "";
  return url.toString();
}
