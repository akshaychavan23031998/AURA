export const KNOWLEDGE_CONTENT_MAX_BYTES = 128 * 1024;

export function normalizeKnowledgeText(input: string): string {
  if (input.includes("\0")) throw new TypeError("Knowledge text contains NUL");
  const normalized = input
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
  if (
    normalized.length === 0 ||
    hasForbiddenControlCharacter(normalized) ||
    Buffer.byteLength(normalized, "utf8") > KNOWLEDGE_CONTENT_MAX_BYTES
  )
    throw new TypeError("Knowledge text is invalid");
  return normalized;
}

export function hasForbiddenControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
    );
  });
}
