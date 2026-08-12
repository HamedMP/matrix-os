// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComputerFileBrowser from "../../desktop/src/renderer/src/features/files/ComputerFileBrowser";
import { createFileUploadController } from "../../desktop/src/renderer/src/features/files/file-upload-controller";
import { AppError } from "../../desktop/src/renderer/src/lib/errors";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Files upload controller", () => {
  it("uses the existing blob route, runs at most three uploads, and ignores stale-scope refreshes", async () => {
    const calls = Array.from({ length: 4 }, () => deferred<{ path: string }>());
    const putBytes = vi.fn((..._args: unknown[]) => calls[putBytes.mock.calls.length - 1]!.promise);
    let scope = "primary|1";
    const onUploaded = vi.fn();
    const controller = createFileUploadController({
      api: { putBytes } as never,
      getScope: () => scope,
      onUploaded,
    });

    const files = Array.from({ length: 4 }, (_, index) => new File([String(index)], `f${index}.txt`));
    controller.enqueue(files, "projects");
    expect(putBytes).toHaveBeenCalledTimes(3);
    expect(putBytes).toHaveBeenNthCalledWith(
      1,
      "/api/files/blob?path=projects%2Ff0.txt",
      files[0],
      { "content-type": "application/octet-stream" },
      { timeoutMs: 30_000 },
    );

    scope = "vm-2|2";
    calls[0]!.resolve({ path: "projects/f0.txt" });
    await waitFor(() => expect(putBytes).toHaveBeenCalledTimes(4));
    calls.slice(1).forEach((call) => call.resolve({ path: "projects/done.txt" }));
    await waitFor(() => expect(onUploaded).not.toHaveBeenCalled());
    controller.dispose();
  });

  it("retains conflicts for Retry or Remove and never sends an overwrite flag", async () => {
    const putBytes = vi.fn()
      .mockRejectedValueOnce(new AppError("server", { detail: "file_exists" }))
      .mockResolvedValueOnce({ path: "retry.txt" });
    const rows = vi.fn();
    const controller = createFileUploadController({
      api: { putBytes } as never,
      getScope: () => "primary|1",
      onUploaded: vi.fn(),
    });
    controller.subscribe(rows);
    controller.enqueue([new File(["x"], "retry.txt")], "");

    await waitFor(() => expect(rows).toHaveBeenLastCalledWith([
      expect.objectContaining({
        name: "retry.txt",
        status: "failed",
        error: "A file with this name already exists.",
      }),
    ]));
    expect(putBytes.mock.calls[0]?.[0]).not.toContain("force=");

    const id = rows.mock.calls.at(-1)?.[0][0].id as string;
    controller.retry(id);
    await waitFor(() => expect(putBytes).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith([]));

    controller.enqueue([new File([new Uint8Array(10 * 1024 * 1024 + 1)], "remove.txt")], "");
    const removeId = rows.mock.calls.at(-1)?.[0][0].id as string;
    controller.remove(removeId);
    expect(rows).toHaveBeenLastCalledWith([]);
    controller.dispose();
  });

  it("rejects files larger than 10 MB without uploading them", () => {
    const putBytes = vi.fn();
    const rows = vi.fn();
    const controller = createFileUploadController({
      api: { putBytes } as never,
      getScope: () => "primary|1",
      onUploaded: vi.fn(),
    });
    controller.subscribe(rows);

    controller.enqueue([new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.bin")], "");

    expect(putBytes).not.toHaveBeenCalled();
    expect(rows).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: "failed", error: "Files are limited to 10 MB." }),
    ]);
    controller.dispose();
  });

  it("ignores unsafe local filenames before constructing an upload path", () => {
    const putBytes = vi.fn();
    const controller = createFileUploadController({
      api: { putBytes } as never,
      getScope: () => "primary|1",
      onUploaded: vi.fn(),
    });

    controller.enqueue([new File(["x"], "../escape.txt")], "projects");

    expect(putBytes).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("caps upload-row subscribers", () => {
    const controller = createFileUploadController({
      api: { putBytes: vi.fn() } as never,
      getScope: () => "primary|1",
      onUploaded: vi.fn(),
    });
    Array.from({ length: 16 }, () => controller.subscribe(() => {}));

    expect(() => controller.subscribe(() => {})).toThrow("upload subscribers unavailable");
    controller.dispose();
  });
});

describe("ComputerFileBrowser uploads", () => {
  const get = vi.fn(async () => ({
    entries: [{ name: "projects", type: "directory", modified: new Date().toISOString() }],
  }));
  const putBytes = vi.fn(async () => ({ path: "uploaded" }));

  beforeEach(() => {
    get.mockClear();
    putBytes.mockClear();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: { get, putBytes, baseUrl: "https://app.matrix-os.com" } as never,
    });
  });

  afterEach(() => cleanup());

  function renderBrowser(mode: "browse" | "folder-picker" = "browse") {
    return render(<Tooltip.Provider><ComputerFileBrowser mode={mode} /></Tooltip.Provider>);
  }

  it("uploads a file dropped on a directory row to that directory", async () => {
    renderBrowser();
    const folder = await screen.findByRole("button", { name: "Open projects" });
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    fireEvent.drop(folder, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(putBytes).toHaveBeenCalledWith(
      "/api/files/blob?path=projects%2Fnotes.md",
      file,
      { "content-type": "text/markdown" },
      { timeoutMs: 30_000 },
    ));
  });

  it("uploads clipboard files to the current listing without intercepting text paste", async () => {
    const { container } = renderBrowser();
    await screen.findByRole("button", { name: "Open projects" });
    const listing = container.querySelector("[data-files-listing]") as HTMLElement;
    const file = new File(["clipboard"], "pasted.txt", { type: "text/plain" });
    const filePaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(filePaste, "clipboardData", { value: { files: [file] } });
    listing.dispatchEvent(filePaste);

    await waitFor(() => expect(putBytes).toHaveBeenCalledWith(
      "/api/files/blob?path=pasted.txt",
      file,
      { "content-type": "text/plain" },
      { timeoutMs: 30_000 },
    ));
    expect(filePaste.defaultPrevented).toBe(true);

    const textPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", { value: { files: [] } });
    listing.dispatchEvent(textPaste);
    expect(textPaste.defaultPrevented).toBe(false);
  });

  it("keeps nested drag depth stable and uploads to the current listing", async () => {
    const { container } = renderBrowser();
    await screen.findByRole("button", { name: "Open projects" });
    const listing = container.querySelector("[data-files-listing]") as HTMLElement;
    const child = screen.getByRole("button", { name: "Open projects" });
    const file = new File(["x"], "root.txt");
    const transfer = { items: [{ kind: "file", getAsFile: () => file }], files: [file] };
    fireEvent.dragEnter(listing, { dataTransfer: transfer });
    fireEvent.dragEnter(child, { dataTransfer: transfer });
    fireEvent.dragLeave(child);
    expect(screen.getByText("Drop files to upload")).toBeTruthy();
    fireEvent.drop(listing, { dataTransfer: transfer });
    await waitFor(() => expect(putBytes).toHaveBeenCalledWith(
      "/api/files/blob?path=root.txt",
      expect.any(File),
      { "content-type": "application/octet-stream" },
      { timeoutMs: 30_000 },
    ));
  });

  it("does not intercept text-only drag and drop in the file listing", async () => {
    const { container } = renderBrowser();
    await screen.findByRole("button", { name: "Open projects" });
    const listing = container.querySelector("[data-files-listing]") as HTMLElement;
    const transfer = { items: [{ kind: "string" }], files: [] };

    expect(fireEvent.dragEnter(listing, { dataTransfer: transfer })).toBe(true);
    expect(fireEvent.drop(listing, { dataTransfer: transfer })).toBe(true);
    expect(screen.queryByText("Drop files to upload")).toBeNull();
    expect(putBytes).not.toHaveBeenCalled();
  });

  it("does not expose upload controls or drop/paste behavior in folder-picker mode", async () => {
    const { container } = renderBrowser("folder-picker");
    await screen.findByRole("button", { name: "Open projects" });
    expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
    const listing = container.querySelector("[data-files-listing]") as HTMLElement;
    fireEvent.drop(listing, { dataTransfer: { files: [new File(["x"], "no.txt")] } });
    fireEvent.paste(listing, { clipboardData: { files: [new File(["x"], "no-paste.txt")] } });
    expect(putBytes).not.toHaveBeenCalled();
  });
});
