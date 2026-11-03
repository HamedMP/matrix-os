// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MermaidDiagram } from "@desktop/renderer/src/components/markdown/MermaidDiagram";
import { MessageResponse } from "@desktop/renderer/src/components/conversation/message";
import { MarkdownContent } from "@desktop/renderer/src/features/editor/MarkdownPreview";

const { renderDiagram } = vi.hoisted(() => ({ renderDiagram: vi.fn() }));
vi.mock("@desktop/renderer/src/components/markdown/render-mermaid", () => ({ MAX_DIAGRAM_LENGTH: 30_000, renderMermaid: renderDiagram }));
const source = 'flowchart LR\n  A["Engineer / local agent"] --> B["Development Matrix"]';
beforeEach(() => {
  renderDiagram.mockReset().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>');
  URL.createObjectURL = vi.fn(() => "blob:diagram");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("renders Mermaid fences in chat and preserves source copying", async () => {
  const copyText = vi.fn();
  render(<MessageResponse copyText={copyText}>{`\`\`\`mermaid\n${source}\n\`\`\``}</MessageResponse>);
  const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
  expect(diagram.getAttribute("src")).toBe("blob:diagram");
  fireEvent.click(screen.getByRole("button", { name: "Show diagram source" }));
  expect(document.querySelector("pre code")?.textContent).toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Copy diagram source" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(source));
});

it("renders the same diagram in Markdown previews", async () => {
  render(<MarkdownContent content={`\`\`\`mermaid\n${source}\n\`\`\``} />);
  expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toBeTruthy();
});

it("keeps invalid or incomplete diagrams readable and recovers on the next content", async () => {
  renderDiagram.mockRejectedValueOnce(new Error("Parse failure with private data"));
  const { rerender } = render(<MermaidDiagram source={"flowchart LR\n A["} />);
  expect(await screen.findByText("Diagram unavailable. View the source below.")).toBeTruthy();
  expect(document.querySelector("pre code")?.textContent).toBe("flowchart LR\n A[");
  expect(screen.queryByText(/private data/)).toBeNull();
  rerender(<MermaidDiagram source={source} />);
  expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toBeTruthy();
});

it("rejects oversized input before parsing and leaves ordinary code alone", async () => {
  render(<MermaidDiagram source={"x".repeat(30_001)} />);
  expect(await screen.findByText("Diagram is too large to render. View the source below.")).toBeTruthy();
  expect(renderDiagram).not.toHaveBeenCalled();
  cleanup();
  render(<MessageResponse copyText={vi.fn()}>{"```typescript\nconst answer = 42;\n```"}</MessageResponse>);
  expect(screen.getByText("const answer = 42;")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("discards stale renders and revokes image URLs on replacement and unmount", async () => {
  let resolveOld!: (svg: string) => void;
  renderDiagram.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveOld = resolve; }));
  const { rerender, unmount } = render(<MermaidDiagram source="flowchart LR; A-->B" />);
  await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1));
  rerender(<MermaidDiagram source={source} />);
  await screen.findByRole("img");
  await act(async () => resolveOld("old"));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagram");
});
