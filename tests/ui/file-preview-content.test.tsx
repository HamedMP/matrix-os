// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewDescriptor } from "@matrix-os/contracts";
import { FilePreviewContent } from "../../packages/ui/src/files/FilePreviewContent";

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
  });
});
