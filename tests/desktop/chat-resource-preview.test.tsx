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
  fireEvent.click(await screen.findByRole("button", { name: "Download chart.png" }));
  expect(download).toHaveBeenCalledWith(home.path);
  await waitFor(() => expect((screen.getByRole("button", { name: "Copy image chart.png" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Copy image chart.png" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Copy image chart.png" }));
  unmount();
  await act(async () => resolveRead(new Blob(["png"])));
  expect(copy).not.toHaveBeenCalled();
});
