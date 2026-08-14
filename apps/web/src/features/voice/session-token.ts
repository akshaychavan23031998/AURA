const ACCESS_TOKEN_KEY = "aura.accessToken";
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function readAccessToken(
  storage: Pick<Storage, "getItem"> = sessionStorage,
): string | undefined {
  const token = storage.getItem(ACCESS_TOKEN_KEY);
  return token !== null && token.length <= 4_096 && JWT.test(token)
    ? token
    : undefined;
}

export function clearAccessToken(
  storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
  storage.removeItem(ACCESS_TOKEN_KEY);
}
