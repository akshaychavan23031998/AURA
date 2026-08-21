import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TrustedCitationList } from "./trusted-citation-list";

describe("TrustedCitationList", () => {
  it("renders only Gateway-returned structured citations", () => {
    render(
      <>
        <p>Model text mentions forged [K99].</p>
        <TrustedCitationList
          citations={[
            {
              id: "K1",
              documentId: "00000000-0000-4000-8000-000000000010",
              chunkId: "00000000-0000-4000-8000-000000000020",
              title: "Deployment notes",
              ordinal: 2,
            },
          ]}
        />
      </>,
    );
    const sources = screen.getByRole("complementary", { name: "Sources" });
    expect(sources).toHaveTextContent("K1");
    expect(sources).toHaveTextContent("Deployment notes");
    expect(sources).not.toHaveTextContent("K99");
    expect(sources.textContent).not.toMatch(/chunk|documentId|vector/i);
  });

  it("renders attacker-controlled citation titles as inert text", () => {
    const title = '<img src=x onerror="globalThis.compromised=true">';
    render(
      <TrustedCitationList
        citations={[
          {
            id: "K1",
            documentId: "00000000-0000-4000-8000-000000000010",
            chunkId: "00000000-0000-4000-8000-000000000020",
            title,
            ordinal: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText(title)).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });
});
