// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewDescriptor } from "@matrix-os/contracts";
import { FilePreviewContent } from "../../packages/ui/src/files/FilePreviewContent";
import { resolvePreviewLink } from "../../packages/ui/src/files/preview-links";

const base: FilePreviewDescriptor = {
  resource: { kind: "home", path: "reports/result.csv" },
  name: "result.csv",
  mimeType: "text/csv",
  sizeBytes: 24,
  kind: "table",
  version: "file_1",
  canDownload: true,
};

beforeEach(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("FilePreviewContent", () => {
  it("resolves Markdown links relative to the previewed file and keeps web links external", async () => {
    vi.unstubAllGlobals();
    const openLink = vi.fn();
    render(<FilePreviewContent descriptor={{ ...base, resource: { kind: "project", projectId: "repo", worktreeId: "old", path: "notes/readme.md" }, name: "readme.md", kind: "markdown" }}
      contentUrl="/notes" loadText={vi.fn(async () => "[Guide](./docs/guide.md) [Web](https://example.com)")} onOpenLink={openLink} />);
    fireEvent.click(await screen.findByRole("link", { name: "Guide" }));
    expect(openLink).toHaveBeenCalledWith({ kind: "file", path: "notes/docs/guide.md" });
    fireEvent.click(screen.getByRole("link", { name: "Web" }));
    expect(openLink).toHaveBeenCalledWith({ kind: "web", url: "https://example.com/" });
    expect(resolvePreviewLink("../../escape.md", { kind: "home", path: "notes/readme.md" })).toBeNull();
    expect(resolvePreviewLink("javascript:alert(1)", { kind: "home", path: "notes/readme.md" })).toBeNull();
  });
  it("renders bounded CSV data as a table", async () => {
    render(<FilePreviewContent descriptor={base} contentUrl="/content" loadText={vi.fn(async () => "name,total\nAda,42")} />);
    expect(await screen.findByRole("table", { name: "result.csv" })).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it.each([
    ["pdf", "application/pdf", "Document preview: report.pdf"],
    ["audio", "audio/mpeg", "Audio preview: report.pdf"],
    ["video", "video/mp4", "Video preview: report.pdf"],
  ] as const)("renders %s through a revocable authenticated blob URL", async (kind, mimeType, label) => {
    render(<FilePreviewContent
      descriptor={{ ...base, name: "report.pdf", kind, mimeType }}
      contentUrl="/content"
      loadBlob={vi.fn(async () => new Blob(["safe"], { type: mimeType }))}
    />);
    await waitFor(() => expect(screen.getByLabelText(label)).toBeTruthy());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("renders HTML in a script-disabled, network-blocked frame", async () => {
    render(<FilePreviewContent
      descriptor={{ ...base, name: "page.html", kind: "html", mimeType: "text/html" }}
      contentUrl="/content"
      loadText={vi.fn(async () => "<h1>Preview</h1><script>parent.bad=true</script>")}
    />);
    const frame = await screen.findByTitle("HTML preview: page.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.queryByTitle("HTML preview: page.html")).toBeNull();
    expect(screen.getByText(/parent.bad=true/)).toBeTruthy();
  });

  it("switches Markdown between rendered and source modes", async () => {
    render(<FilePreviewContent descriptor={{ ...base, name: "notes.md", kind: "markdown" }}
      contentUrl="/notes" loadText={vi.fn(async () => "# Notes\n\n**Ready**")} />);
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText(/# Notes/)).toBeTruthy();
  });
});
