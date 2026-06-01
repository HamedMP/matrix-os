// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
}));

import { MarkdownViewer } from "../../shell/src/components/preview-window/MarkdownViewer.js";

describe("MarkdownViewer SVG previews", () => {
  it("renders local SVG image syntax through the gateway file path", () => {
    render(
      <MarkdownViewer
        content={"![Architecture diagram](assets/diagram.svg)\n\nAfter image."}
        sourcePath="docs/readme.md"
      />,
    );

    const image = screen.getByRole("img", { name: "Architecture diagram" });

    expect(image.getAttribute("src")).toBe(
      "http://gateway.test/files/docs/assets/diagram.svg",
    );
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(screen.getByText("After image.")).toBeTruthy();
  });

  it("uses a readable placeholder for unsafe and broken SVG previews", () => {
    const { rerender } = render(
      <MarkdownViewer
        content={"![Unsafe](javascript:alert(1).svg)\n\nDocument continues."}
        sourcePath="docs/readme.md"
      />,
    );

    expect(screen.getByText("SVG preview unavailable")).toBeTruthy();
    expect(screen.getByText("Document continues.")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Unsafe" })).toBeNull();

    rerender(
      <MarkdownViewer
        content={"![Missing](missing.svg)\n\nDocument continues."}
        sourcePath="docs/readme.md"
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Missing" }));

    expect(screen.getByText("SVG preview unavailable")).toBeTruthy();
    expect(screen.getByText("Document continues.")).toBeTruthy();

    rerender(
      <MarkdownViewer
        content={"![Inline](data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E%3C/svg%3E)"}
        sourcePath="docs/readme.md"
      />,
    );

    expect(screen.getByText("SVG preview unavailable")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Inline" })).toBeNull();
  });

  it("renders validated remote HTTPS SVG previews without proxy fetching", () => {
    render(
      <MarkdownViewer
        content={"![Remote](https://cdn.example.com/assets/diagram.svg?v=1)"}
        sourcePath="docs/readme.md"
      />,
    );

    const image = screen.getByRole("img", { name: "Remote" });

    expect(image.getAttribute("src")).toBe(
      "https://cdn.example.com/assets/diagram.svg?v=1",
    );
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});
