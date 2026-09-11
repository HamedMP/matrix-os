// @vitest-environment jsdom
import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesWorkspace from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useBrowserViewPreference } from "../../desktop/src/renderer/src/features/files/browser-view-preference";

const invoke = vi.fn();
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: (...args: unknown[]) => invoke(...args), onEvent: () => () => {} }));
const entries = [
  { name: "archive.zip", type: "file", size: 100 },
  { name: "other.bin", type: "file", size: 5 },
  { name: "large.zip", type: "file", size: 11 * 1024 * 1024 },
  { name: "folder", type: "directory" },
];
function setup() {
  const get = vi.fn(async (path: string) => path.includes("/list?") ? { entries } : { size: 100 });
  useConnection.setState({ api: { get, getText: vi.fn(), getBlob: vi.fn(), baseUrl: "https://app.matrix-os.com" } as never, status: "signed-in", runtimeSlot: "preview", authGeneration: 3 });
  return render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ status: "saved" });
  useBrowserViewPreference.setState({ view: "list" });
});
afterEach(cleanup);

describe("Files single-file download actions", () => {
  it("downloads an unsupported preview through scoped native IPC", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open archive.zip" }));
    expect(await screen.findByText("Preview not available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:download-file", {
      path: "archive.zip", runtimeSlot: "preview", authGeneration: 3, requestId: expect.any(String),
    }));
    expect(await screen.findByText("Download saved.")).toBeTruthy();
  });

  it.each(["list", "grid"] as const)("downloads the right-clicked file in %s view, not a previous selection", async (view) => {
    useBrowserViewPreference.setState({ view });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open archive.zip" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open other.bin" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:download-file", expect.objectContaining({ path: "other.bin" })));
  });

  it("allows a file above 10 MiB to reach the native service", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open large.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:download-file", expect.objectContaining({ path: "large.zip" })));
  });

  it("cancels an in-flight download and does not leak raw errors", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((channel: string) => channel === "runtime:download-file" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true }));
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open archive.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:cancel-file-download", { requestId: expect.any(String) }));
    await act(async () => finish({ status: "error", code: "EACCES /private/path" }));
    expect(await screen.findByText("Download cancelled.")).toBeTruthy();
    expect(screen.queryByText(/EACCES/)).toBeNull();
  });

  it("cancels on runtime change and suppresses a late success from the previous computer", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((channel: string) => channel === "runtime:download-file" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true }));
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open archive.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:download-file", expect.anything()));
    await act(async () => useConnection.setState({ runtimeSlot: "primary" }));
    await act(async () => finish({ status: "saved" }));
    expect(screen.queryByText("Download saved.")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("runtime:cancel-file-download", { requestId: expect.any(String) });
  });
});
