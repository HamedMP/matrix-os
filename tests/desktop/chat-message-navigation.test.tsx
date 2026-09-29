// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageResponse } from "@desktop/renderer/src/components/conversation/message";
import { ConversationTranscript } from "@desktop/renderer/src/components/conversation/transcript";
import { resolveChatMessageLink } from "@matrix-os/contracts";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("classifies links consistently and rejects unsafe file and protocol inputs", () => {
  expect(resolveChatMessageLink("https://example.com")).toEqual({ kind: "web", url: "https://example.com/" });
  expect(resolveChatMessageLink("/home/matrix/home/reports/file.md:12")).toEqual({ kind: "file", path: "reports/file.md" });
  for (const input of ["javascript:alert(1)", "../secrets", "file:///etc/passwd", "https://user:password@example.com"]) expect(resolveChatMessageLink(input)).toBeNull();
});

it("routes web links and file references through separate Chat actions", () => {
  const openFile = vi.fn(() => true);
  const openWebLink = vi.fn(() => true);
  render(<MessageResponse copyText={vi.fn()} openFile={openFile} openWebLink={openWebLink}>
    {"[Website](https://example.com/docs) and [Report](reports/result.md)"}
  </MessageResponse>);
  fireEvent.click(screen.getByRole("link", { name: "Website" }));
  expect(openWebLink).toHaveBeenCalledWith("https://example.com/docs");
  expect(openFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "Report" }));
  expect(openFile).toHaveBeenCalledWith("reports/result.md");
});

it("turns a local Markdown image into File Preview navigation instead of a broken image", () => {
  const openFile = vi.fn(() => true);
  render(<MessageResponse copyText={vi.fn()} openFile={openFile}>{"![Generated whale](data/chat-artifacts/whale.png)"}</MessageResponse>);
  expect(screen.queryByRole("img", { name: "Generated whale" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview image Generated whale" }));
  expect(openFile).toHaveBeenCalledWith("data/chat-artifacts/whale.png");
});

it("renders a local Markdown image using the authenticated loader", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:chart"), revokeObjectURL: vi.fn() }));
  const loadFileImage = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
  const openFile = vi.fn(() => true);
  render(<MessageResponse copyText={vi.fn()} openFile={openFile} loadFileImage={loadFileImage}>{"![Chart](apps/ai-adoption/chart-light.png)"}</MessageResponse>);
  expect(await screen.findByRole("img", { name: "Chart" })).toBeTruthy();
  expect(loadFileImage).toHaveBeenCalledWith("apps/ai-adoption/chart-light.png");
  fireEvent.click(screen.getByRole("button", { name: "Open image Chart" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Chart in File Preview" }));
  expect(openFile).toHaveBeenCalledWith("apps/ai-adoption/chart-light.png");
});

it("launches a catalog-backed app directory rather than treating it as a passive folder", () => {
  const openApp = vi.fn(() => true);
  const openFile = vi.fn(() => true);
  render(<MessageResponse copyText={vi.fn()} openFile={openFile} openApp={openApp}
    resolveApp={(path) => resolveChatMessageLink(path)?.kind === "file" && path === "~/apps/ai-adoption" ? { name: "AI Adoption" } : null}>
    {"Open `~/apps/ai-adoption`; inspect `apps/ai-adoption/src/App.tsx`."}
  </MessageResponse>);
  fireEvent.click(screen.getByRole("button", { name: "Open app AI Adoption" }));
  expect(openApp).toHaveBeenCalledWith("~/apps/ai-adoption");
  expect(openFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open App.tsx" }));
  expect(openFile).toHaveBeenCalledWith("apps/ai-adoption/src/App.tsx");
});

it.each(["[Chart](apps/ai-adoption/chart.png)", "`apps/ai-adoption/chart.png`"])("shows an image reference inline: %s", async (markdown) => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:chart"), revokeObjectURL: vi.fn() }));
  const loadFileImage = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
  render(<MessageResponse copyText={vi.fn()} openFile={vi.fn()} loadFileImage={loadFileImage}>{markdown}</MessageResponse>);
  expect(await screen.findByRole("img")).toBeTruthy();
  expect(loadFileImage).toHaveBeenCalledWith("apps/ai-adoption/chart.png");
});

it("shows a retryable image failure instead of loading forever", async () => {
  const loadImage = vi.fn(async () => { throw new Error("Missing"); });
  render(<ConversationTranscript callbacks={{ copyText: vi.fn(), loadImage }} turns={[{
    id: "turn", startedAt: 1, endedAt: 2, active: false, work: [],
    user: { kind: "message", id: "message", role: "user", phase: "final", markdown: "", copyText: "", timestamp: 1,
      content: [{ kind: "image", id: "attachment", label: "Image.png", src: "/api/files/blob?path=uploads/image.png" }],
    },
  }]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry Image.png" }));
  expect(loadImage).toHaveBeenCalledTimes(2);
});

it("preserves the persisted run root for app resolution and launch without remounting on equivalent roots", () => {
  const resolveApp = vi.fn(() => ({ name: "Chart" }));
  const openApp = vi.fn(() => true);
  const props = () => ({ callbacks: { copyText: vi.fn(), resolveApp, openApp }, turns: [{
    id: "turn", startedAt: 1, endedAt: 2, active: false, work: [],
    executionRoot: { kind: "worktree" as const, projectId: "project_1", worktreeId: "wt_1" },
    final: { kind: "message" as const, id: "assistant", role: "assistant" as const, phase: "final" as const, markdown: "`~/apps/chart`", copyText: "", timestamp: 2 },
  }] });
  const { rerender } = render(<ConversationTranscript {...props()} />);
  const button = screen.getByRole("button", { name: "Open app Chart" });
  rerender(<ConversationTranscript {...props()} />);
  expect(screen.getByRole("button", { name: "Open app Chart" })).toBe(button);
  fireEvent.click(button);
  expect(openApp).toHaveBeenCalledWith("~/apps/chart", { kind: "worktree", projectId: "project_1", worktreeId: "wt_1" });
});

it("opens an attached file using its owner reference instead of its display label", () => {
  const openAttachment = vi.fn(() => true);
  render(<ConversationTranscript callbacks={{ copyText: vi.fn(), openAttachment }} turns={[{
    id: "turn", startedAt: 1, endedAt: 2, active: false, work: [],
    user: { kind: "message", id: "message", role: "user", phase: "final", markdown: "", copyText: "", timestamp: 1,
      content: [{ kind: "reference", id: "attachment", referenceKind: "file", label: "Report.pdf", path: "uploads/report.pdf" }],
    },
  }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview Report.pdf" }));
  expect(openAttachment).toHaveBeenCalledWith("uploads/report.pdf");
});

it("renders assistant artifacts and opens their owner reference in File Preview", () => {
  const openAttachment = vi.fn(() => true);
  render(<ConversationTranscript callbacks={{ copyText: vi.fn(), openAttachment }} turns={[{
    id: "turn", startedAt: 1, endedAt: 2, active: false, work: [],
    final: { kind: "message", id: "assistant", role: "assistant", phase: "final", markdown: "", copyText: "", timestamp: 2,
      content: [
        { kind: "image", id: "image", label: "Generated.png", src: "/api/file-previews/content?kind=home&path=data%2Fimage.png", path: "data/image.png" },
        { kind: "reference", id: "report", referenceKind: "file", label: "Report.pdf", path: "data/report.pdf" },
      ],
    },
  }]} />);
  expect(screen.getByRole("button", { name: "Open image Generated.png" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preview Report.pdf" }));
  expect(openAttachment).toHaveBeenCalledWith("data/report.pdf");
});

it("shows a glare image placeholder while image generation is running", () => {
  render(<ConversationTranscript callbacks={{ copyText: vi.fn() }} turns={[{
    id: "turn", startedAt: Date.now(), endedAt: Date.now(), active: true,
    work: [{
      kind: "activity-group", id: "generation", activities: [{
        id: "image-generation", kind: "image_generation", state: "running", label: "Generating image",
      }],
    }],
  }]} />);
  const placeholder = screen.getByRole("status", { name: "Generating image" });
  expect(placeholder.className).toContain("image-generation-glare");
  expect(placeholder.getAttribute("data-state")).toBe("running");
});

it("preserves the source root when opening an absolute message file link", () => {
  const openFile = vi.fn(() => true);
  const path = "/home/matrix/home/apps/games/chess/src/App.tsx";
  render(<MessageResponse copyText={vi.fn()} openFile={openFile}>{`[App.tsx](${path})`}</MessageResponse>);
  fireEvent.click(screen.getByRole("link", { name: "App.tsx" }));
  expect(openFile).toHaveBeenCalledWith(path);
});

it("does not treat package names or API members as local files", () => {
  const openFile = vi.fn(() => true);
  render(<MessageResponse copyText={vi.fn()} openFile={openFile}>{"Uses `chess.js` and `MatrixOS.db`; see `src/main.ts`."}</MessageResponse>);
  expect(screen.queryByRole("button", { name: "Open chess.js" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open MatrixOS.db" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open main.ts" }));
  expect(openFile).toHaveBeenCalledWith("src/main.ts");
});

it("keeps file links mounted when navigation callbacks refresh", () => {
  const previous = vi.fn(() => true);
  const current = vi.fn(() => true);
  const { rerender } = render(<MessageResponse copyText={vi.fn()} openFile={previous}>{"[App.tsx](src/App.tsx)"}</MessageResponse>);
  const link = screen.getByRole("link", { name: "App.tsx" });
  rerender(<MessageResponse copyText={vi.fn()} openFile={current}>{"[App.tsx](src/App.tsx)"}</MessageResponse>);
  expect(screen.getByRole("link", { name: "App.tsx" })).toBe(link);
  fireEvent.click(link);
  expect(current).toHaveBeenCalledWith("src/App.tsx");
  expect(previous).not.toHaveBeenCalled();
});
