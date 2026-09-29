// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InspectorFilePreview } from "../../desktop/src/renderer/src/features/panels/InspectorFilesPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const { download, copy } = vi.hoisted(() => ({ download: vi.fn(), copy: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/features/files/use-file-download", () => ({
  useDesktopFileDownload: () => ({ download, pending: false }),
}));
vi.mock("../../packages/ui/src/files/file-image-actions", () => ({ copyFileImage: copy, savePreviewBlob: vi.fn() }));

const home = { kind: "home" as const, path: "apps/chart/chart.png", label: "chart.png" };
const descriptor = { resource: { kind: "home", path: home.path }, name: "chart.png", mimeType: "image/png", kind: "image", version: "image_v1", canDownload: true, sizeBytes: 100 };
let get: ReturnType<typeof vi.fn>;
let getBlob: ReturnType<typeof vi.fn>;
let forRuntime: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  get = vi.fn(async () => descriptor);
  getBlob = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
  forRuntime = vi.fn(() => ({ get, getBlob }));
  useConnection.setState({ ...useConnection.getInitialState(), api: { forRuntime } as never, runtimeSlot: "pr-qa", authGeneration: 9 }, true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("loads a selected home image from the pinned runtime and offers native download and image copy", async () => {
  render(<InspectorFilePreview target={home} />);
  const image = await screen.findByRole("img", { name: "chart.png" });
  expect(screen.queryByRole("button", { name: "Download chart.png" })).toBeNull();
  fireEvent.contextMenu(image);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Download chart.png" }));
  expect(download).toHaveBeenCalledWith(home.path);
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy image chart.png" }).hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy image chart.png" }));
  await waitFor(() => expect(copy).toHaveBeenCalled());
  expect(forRuntime).toHaveBeenCalledWith("pr-qa");
  expect(getBlob.mock.calls.every(([url]) => url.includes("kind=home") && url.includes("path=apps%2Fchart%2Fchart.png"))).toBe(true);
});

it("renders project HTML charts through the authenticated worktree preview", async () => {
  const resource = { kind: "project" as const, projectId: "project_1", worktreeId: "worktree_1", path: "chart.html" };
  get.mockResolvedValue({ ...descriptor, resource, name: "chart.html", mimeType: "text/html", kind: "html" });
  getBlob.mockResolvedValue(new Blob(["<h1>Chart</h1>"], { type: "text/html" }));
  render(<InspectorFilePreview target={{ ...resource, label: "chart.html" }} />);
  const frame = await screen.findByTitle("HTML preview: chart.html");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(get.mock.calls[0][0]).toContain("worktreeId=worktree_1");
  expect(screen.queryByRole("button", { name: "Copy image chart.html" })).toBeNull();
});

it("does not copy an image when its selected preview is replaced during the read", async () => {
  let resolveRead!: (blob: Blob) => void;
  getBlob.mockImplementation(() => new Promise<Blob>((resolve) => { resolveRead = resolve; }));
  const { unmount } = render(<InspectorFilePreview target={home} />);
  fireEvent.contextMenu(await screen.findByText("chart.png", { selector: "span" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy image chart.png" }));
  unmount();
  await act(async () => resolveRead(new Blob(["png"])));
  expect(copy).not.toHaveBeenCalled();
});

it.each(["text", "markdown"])("keeps a bounded preview for large project %s and labels its truncation", async (kind) => {
  const resource = { kind: "project" as const, projectId: "project_1", path: "large.txt" };
  get.mockResolvedValue({ ...descriptor, resource, name: "large.txt", kind, mimeType: "text/plain", sizeBytes: 2 * 1024 * 1024 });
  const getText = vi.fn(async () => "First bounded part");
  forRuntime.mockReturnValue({ get, getBlob, getText });
  render(<InspectorFilePreview target={{ ...resource, label: "large.txt" }} />);
  await screen.findByText("First bounded part");
  expect(screen.getByText("Preview truncated.")).toBeTruthy();
  expect(getText).toHaveBeenCalledWith(expect.stringContaining("projectId=project_1"), { maxBytes: 65536, headers: { Range: "bytes=0-65535" } });
});

it("does not offer an impossible buffered download for a large project file", async () => {
  const resource = { kind: "project" as const, projectId: "project_1", path: "large.zip" };
  get.mockResolvedValue({ ...descriptor, resource, name: "large.zip", kind: "unsupported", mimeType: "application/zip", sizeBytes: 60 * 1024 * 1024 });
  render(<InspectorFilePreview target={{ ...resource, label: "large.zip" }} />);
  await screen.findByText("Project downloads are available for files up to 50 MiB.");
  expect(screen.queryByRole("button", { name: "Download large.zip" })).toBeNull();
  expect(getBlob).not.toHaveBeenCalled();
});
