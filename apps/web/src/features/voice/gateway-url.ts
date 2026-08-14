export function resolveGatewayHttpUrl(
  location?: Pick<Location, "protocol" | "hostname">,
): URL {
  const configured = process.env.NEXT_PUBLIC_GATEWAY_URL;
  const browserLocation =
    location ?? (typeof window === "undefined" ? undefined : window.location);
  const base =
    configured === undefined || configured === ""
      ? browserLocation === undefined
        ? "http://localhost:4000"
        : `${browserLocation.protocol}//${browserLocation.hostname}:4000`
      : configured;
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Invalid Gateway URL");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveVoiceWebSocketUrl(
  location?: Pick<Location, "protocol" | "hostname">,
): string {
  const url = resolveGatewayHttpUrl(location);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/voice/session";
  url.search = "";
  url.hash = "";
  return url.toString();
}
