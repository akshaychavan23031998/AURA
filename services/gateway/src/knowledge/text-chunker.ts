export const KNOWLEDGE_CHUNK_TARGET_CHARACTERS = 1200;
export const KNOWLEDGE_CHUNK_MAX_CHARACTERS = 2000;
export const KNOWLEDGE_CHUNK_MAX_COUNT = 128;

export function chunkKnowledgeText(content: string): readonly string[] {
  const paragraphs = content
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim());
  const chunks: string[] = [];
  let current = "";

  const push = (value: string) => {
    const chunk = value.trim();
    if (chunk.length === 0) return;
    if (chunk.length > KNOWLEDGE_CHUNK_MAX_CHARACTERS)
      throw new TypeError("Knowledge chunk exceeds hard maximum");
    chunks.push(chunk);
    if (chunks.length > KNOWLEDGE_CHUNK_MAX_COUNT)
      throw new TypeError("Knowledge document produces too many chunks");
  };

  for (const paragraph of paragraphs) {
    for (const segment of splitOversizedParagraph(paragraph)) {
      const combined =
        current.length === 0 ? segment : `${current}\n\n${segment}`;
      if (
        current.length > 0 &&
        combined.length > KNOWLEDGE_CHUNK_TARGET_CHARACTERS
      ) {
        push(current);
        current = segment;
      } else {
        current = combined;
      }
    }
  }
  push(current);
  if (chunks.length === 0) throw new TypeError("Knowledge document is empty");
  return Object.freeze(chunks);
}

function splitOversizedParagraph(paragraph: string): readonly string[] {
  const segments: string[] = [];
  let remaining = paragraph;
  while (remaining.length > KNOWLEDGE_CHUNK_MAX_CHARACTERS) {
    const candidate = remaining.slice(0, KNOWLEDGE_CHUNK_MAX_CHARACTERS + 1);
    const whitespace = Math.max(
      candidate.lastIndexOf(" "),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf("\t"),
    );
    const cut =
      whitespace >= KNOWLEDGE_CHUNK_TARGET_CHARACTERS
        ? whitespace
        : KNOWLEDGE_CHUNK_MAX_CHARACTERS;
    segments.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) segments.push(remaining);
  return segments;
}
