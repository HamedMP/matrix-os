import { describe, expect, it, vi } from "vitest";
import { createBrowserFileDownload } from "../../shell/src/lib/file-download";

const input = () => ({ path: "files/archive.zip", requestId: "1a745da3-7551-434e-8947-634928188816", signal: new AbortController().signal });

describe("web single-file download transport", () => {
  it("preserves the explicit VM route, authenticates, and hands exact bytes to the browser", async () => {
    const bytes = new Uint8Array([0, 255, 128]);
    const fetchFn = vi.fn(async () => new Response(bytes, { headers: { "content-length": "3" } }));
    const save = vi.fn();
    const client = createBrowserFileDownload("https://app.matrix-os.com/vm/review/~runtime/preview", { fetchFn, save });
    await expect(client.download(input())).resolves.toEqual({ status: "handed_off" });
    expect(fetchFn).toHaveBeenCalledWith("https://app.matrix-os.com/vm/review/~runtime/preview/api/files/blob?path=files%2Farchive.zip", expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "archive.zip");
    expect(new Uint8Array(await (save.mock.calls[0]![0] as Blob).arrayBuffer())).toEqual(bytes);
  });
  it.each([413, 401, 404, 500])("never saves an HTTP %i error body", async (status) => {
    const save = vi.fn();
    const client = createBrowserFileDownload("https://app.matrix-os.com", { fetchFn: vi.fn(async () => new Response("private", { status })), save });
    const result = await client.download(input());
    expect(result.status).toBe("error");
    expect(save).not.toHaveBeenCalled();
  });
  it("rejects actual bytes beyond the limit and truncated bodies", async () => {
    const save = vi.fn();
    for (const response of [new Response(new Uint8Array(10 * 1024 * 1024 + 1)), new Response("short", { headers: { "content-length": "90" } })]) {
      const client = createBrowserFileDownload("https://app.matrix-os.com", { fetchFn: vi.fn(async () => response), save });
      expect((await client.download(input())).status).toBe("error");
    }
    expect(save).not.toHaveBeenCalled();
  });
  it("does not save after cancellation during fetch", async () => {
    const controller = new AbortController();
    const save = vi.fn();
    const client = createBrowserFileDownload("https://app.matrix-os.com", { fetchFn: vi.fn(async () => { controller.abort(); return new Response("body"); }), save });
    await expect(client.download({ ...input(), signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    expect(save).not.toHaveBeenCalled();
  });
});
