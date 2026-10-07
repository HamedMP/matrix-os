import { describe, expect, it, vi } from "vitest";
import { createSelectedFileUploadController, isSafeUploadName, MAX_SELECTED_UPLOAD_BYTES } from "../../packages/contracts/src/file-upload.js";

const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
describe("shared selected-file upload state", () => {
  it("binds destination, keeps failures for retry, and only refreshes the original runtime", async () => {
    let scope = "owner/computer-a";
    const upload = vi.fn().mockRejectedValueOnce(new Error("secret upstream error")).mockResolvedValue(undefined);
    const refreshed = vi.fn();
    const controller = createSelectedFileUploadController({ getScope: () => scope, upload, onUploaded: refreshed });
    const rows = vi.fn(); controller.subscribe(rows);
    controller.enqueue([{ name: "bank.csv", size: 3 }], "imports");
    await tick();
    const item = rows.mock.calls.at(-1)![0][0];
    expect(item).toMatchObject({ status: "failed", error: "Upload failed. Try again.", destination: "imports" });
    scope = "owner/computer-b";
    controller.retry(item.id);
    await tick();
    expect(upload).toHaveBeenCalledTimes(1);
    scope = "owner/computer-a";
    controller.retry(item.id); await tick();
    expect(upload.mock.calls[1]![1]).toBe("imports/bank.csv");
    expect(refreshed).toHaveBeenCalledWith("imports");
    controller.dispose();
  });

  it("rejects a runtime change between selection and the transport microtask", async () => {
    let scope = "original";
    const upload = vi.fn().mockResolvedValue(undefined);
    const controller = createSelectedFileUploadController({ getScope: () => scope, upload, onUploaded: vi.fn() });
    controller.enqueue([{ name: "private.csv", size: 1 }], "imports");
    scope = "other";
    await tick();
    expect(upload).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual([expect.objectContaining({ status: "failed" })]);
    controller.dispose();
  });

  it("cancels active work, keeps selection recoverable, and aborts everything on disposal", async () => {
    const signals: AbortSignal[] = [];
    const upload = vi.fn((_file, _path, signal: AbortSignal) => { signals.push(signal); return new Promise<void>(() => {}); });
    const controller = createSelectedFileUploadController({ getScope: () => "a", upload, onUploaded: vi.fn() });
    const rows = vi.fn(); controller.subscribe(rows);
    controller.enqueue([{ name: "photo.jpg", size: 3 }, { name: "game.pgn", size: 3 }], "");
    await tick();
    controller.cancel(rows.mock.calls.at(-1)![0][0].id);
    expect(signals[0]!.aborted).toBe(true);
    expect(rows.mock.calls.at(-1)![0][0].status).toBe("cancelled");
    controller.dispose();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("caps active uploads, queue, subscribers and bytes without uploading invalid names", async () => {
    const upload = vi.fn(() => new Promise<void>(() => {}));
    const controller = createSelectedFileUploadController({ getScope: () => "a", upload, onUploaded: vi.fn() });
    const rows = vi.fn(); controller.subscribe(rows);
    controller.enqueue([{ name: "../bad", size: 1 }, { name: "large.pdf", size: MAX_SELECTED_UPLOAD_BYTES + 1 }, ...Array.from({ length: 40 }, (_, i) => ({ name: `${i}.pgn`, size: 1 }))], "");
    await tick();
    expect(upload).toHaveBeenCalledTimes(3);
    expect(rows.mock.calls.at(-1)![0]).toHaveLength(32);
    expect(rows.mock.calls.at(-1)![0][0].error).toBe("Files are limited to 10 MB.");
    Array.from({ length: 15 }, () => controller.subscribe(() => {}));
    expect(() => controller.subscribe(() => {})).toThrow();
    expect(isSafeUploadName("bank.csv")).toBe(true);
    expect(isSafeUploadName("bad\\name")).toBe(false);
    controller.dispose();
  });
});
