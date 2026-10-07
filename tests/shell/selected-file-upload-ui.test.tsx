// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadFromDevice } from "../../shell/src/components/file-browser/UploadFromDevice";
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "owner-token" }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("selected uploads in shared Web Files", () => {
  it("sends selected exports to the captured computer and retains safe failures for retry", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("private path failure")).mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);
    const refreshed = vi.fn();
    render(<UploadFromDevice identity="owner:runtime" gatewayUrl="https://app.matrix-os.com/vm/computer/~runtime/preview" currentPath="imports" onUploaded={refreshed} />);
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["csv"], "bank.csv", { type: "text/csv" })] } });
    await screen.findByText("Upload failed. Try again.");
    expect(fetch).toHaveBeenCalledWith("https://app.matrix-os.com/vm/computer/~runtime/preview/api/files/blob?path=imports%2Fbank.csv", expect.objectContaining({ method: "PUT", signal: expect.any(AbortSignal), body: expect.any(File), headers: { Authorization: "Bearer owner-token", "Content-Type": "text/csv" } }));
    fireEvent.click(screen.getByRole("button", { name: "Retry bank.csv" }));
    await waitFor(() => expect(refreshed).toHaveBeenCalledWith("imports"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending upload when changing computers", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}); }));
    const props = { currentPath: "", onUploaded: vi.fn() };
    const view = render(<UploadFromDevice {...props} identity="a" gatewayUrl="https://app.matrix-os.com/vm/a" />);
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["pgn"], "game.pgn")] } });
    await waitFor(() => expect(signal).toBeDefined());
    view.rerender(<UploadFromDevice {...props} identity="b" gatewayUrl="https://app.matrix-os.com/vm/b" />);
    expect(signal!.aborted).toBe(true);
    expect(screen.queryByText("game.pgn")).toBeNull();
  });
  it("uses the latest refresh callback while preserving the selected destination", async () => {
    let complete!: (response: { ok: boolean; status: number }) => void;
    const fetch = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const original = vi.fn(); const latest = vi.fn();
    const target = { identity: "owner:a", gatewayUrl: "https://app.matrix-os.com/vm/a" };
    const view = render(<UploadFromDevice {...target} currentPath="imports" onUploaded={original} />);
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [new File(["csv"], "bank.csv")] } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<UploadFromDevice {...target} currentPath="other" onUploaded={latest} />);
    complete({ ok: true, status: 200 });
    await waitFor(() => expect(latest).toHaveBeenCalledWith("imports"));
    expect(original).not.toHaveBeenCalled();
    expect(fetch.mock.calls).toHaveLength(1);
  });
});
