// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDownloadProvider, FileDownloadAction } from "../../shell/src/components/file-browser/FileDownloadProvider";
import { FileContextMenu } from "../../shell/src/components/file-browser/FileContextMenu";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser";

const download = vi.fn();
const dispose = vi.fn();
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "user-a", sessionId: "session-a" }) }));
vi.mock("../../shell/src/lib/file-download", () => ({ createBrowserFileDownload: () => ({ download, dispose }) }));

beforeEach(() => {
  download.mockReset();
  download.mockResolvedValue({ status: "handed_off" });
  useFileBrowser.setState({ currentPath: "projects", selectedPaths: new Set(), entries: [{ name: "binary.zip", type: "file", size: 3 }] });
});
afterEach(cleanup);

describe("web Files download UI", () => {
  it("offers an explicit file action with browser handoff feedback", async () => {
    render(<FileDownloadProvider><FileDownloadAction path="projects/binary.zip" size={3} /></FileDownloadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "projects/binary.zip" })));
    expect(await screen.findByText("Download sent to your browser. Check or cancel it in your browser’s downloads.")).toBeTruthy();
  });
  it("downloads the context-menu target without changing structural management actions", async () => {
    render(<FileDownloadProvider><FileContextMenu><div data-web-file-path="projects/binary.zip" data-web-file-type="file">binary.zip</div></FileContextMenu></FileDownloadProvider>);
    fireEvent.contextMenu(screen.getByText("binary.zip"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.objectContaining({ path: "projects/binary.zip" })));
  });
  it("aborts pending preflight when the Files provider unmounts", async () => {
    let signal!: AbortSignal;
    let finish!: (value: unknown) => void;
    download.mockImplementation((input) => { signal = input.signal; return new Promise((resolve) => { finish = resolve; }); });
    const view = render(<FileDownloadProvider><FileDownloadAction path="projects/binary.zip" /></FileDownloadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ status: "handed_off" }));
    expect(screen.queryByText(/Download sent/)).toBeNull();
  });
});
