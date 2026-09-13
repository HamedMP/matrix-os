import { describe, expect, it, vi } from "vitest";
import { createBrowserFileDownload } from "../../shell/src/lib/file-download";

const input = () => ({ path: "files/archive.zip", requestId: "1a745da3-7551-434e-8947-634928188816", signal: new AbortController().signal });

describe("web single-file download transport", () => {
  it("preflights metadata only and hands the authenticated explicit VM URL to the browser", async () => {
    const response = new Response(null, { headers: { "content-length": String(8 * 1024 ** 3) } });
    response.blob = vi.fn(() => { throw new Error("must not buffer"); });
    response.arrayBuffer = vi.fn(() => { throw new Error("must not buffer"); });
    const fetchFn = vi.fn(async () => response);
    const save = vi.fn();
    const client = createBrowserFileDownload("https://app.matrix-os.com/vm/review/~runtime/preview", { fetchFn, save });
    await expect(client.download(input())).resolves.toEqual({ status: "handed_off" });
    const url = "https://app.matrix-os.com/vm/review/~runtime/preview/api/files/media?path=files%2Farchive.zip&download=true";
    expect(fetchFn).toHaveBeenCalledWith(url, expect.objectContaining({ method: "HEAD", credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(save).toHaveBeenCalledWith(url, "archive.zip");
    expect(response.blob).not.toHaveBeenCalled();
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });
  it.each([204, 206, 401, 403, 404, 429, 500])("does not hand an HTTP %i failure to the browser", async (status) => {
    const save = vi.fn();
    const client = createBrowserFileDownload("https://app.matrix-os.com", { fetchFn: vi.fn(async () => new Response(null, { status })), save });
    expect((await client.download(input())).status).toBe("error");
    expect(save).not.toHaveBeenCalled();
  });
  it("does not hand off after cancellation or disposal during preflight", async () => {
    for (const dispose of [false, true]) {
      const controller = new AbortController();
      const save = vi.fn();
      const client = createBrowserFileDownload("https://app.matrix-os.com", { fetchFn: vi.fn(async () => { if (dispose) client.dispose(); else controller.abort(); return new Response(null); }), save });
      await expect(client.download({ ...input(), signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
      expect(save).not.toHaveBeenCalled();
    }
  });
  it("rejects invalid owner paths before any network request", async () => {
    const fetchFn = vi.fn();
    const client = createBrowserFileDownload("https://app.matrix-os.com", { fetchFn, save: vi.fn() });
    expect((await client.download({ ...input(), path: "../private" })).status).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
