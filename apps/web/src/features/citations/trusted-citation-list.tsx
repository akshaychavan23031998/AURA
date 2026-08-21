export interface TrustedCitation {
  readonly id: string;
  readonly documentId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly ordinal: number;
}

export function TrustedCitationList({
  citations,
}: Readonly<{ citations: readonly TrustedCitation[] }>) {
  if (citations.length === 0) return null;
  return (
    <aside className="citation-panel" aria-label="Sources">
      <h3>Sources</h3>
      <ol>
        {citations.map((citation) => (
          <li key={citation.id}>
            <span className="citation-reference">{citation.id}</span>
            <span>{citation.title}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
