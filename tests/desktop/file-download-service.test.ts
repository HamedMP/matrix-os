import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileDownloadService } from "../../desktop/src/main/files/file-download-service";

const request = {
  requestId: "1a745da3-7551-434e-8947-634928188816",
  path: "projects/报告 & data.zip",
  runtimeSlot: "preview",
  authGeneration: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("native single-file downloads", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "matrix-download-test-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function harness(options: { response?: Response; destination?: string | null; idleTimeoutMs?: number } = {}) {
    const status = { signedIn: true, runtimeSlot: "preview", authGeneration: 3 };
    const auth = {
      getToken: vi.fn(() => "private-token"),
      getGatewayOrigin: () => "https://app.matrix-os.com",
      getStatus: () => status,
    };
    const chooseDestination = vi.fn(async () => options.destination === undefined ? join(dir, "report.zip") : options.destination);
    const bytes = new Uint8Array([0, 255, 10, 128, 0]);
    const fetchFn = vi.fn(async () => options.response ?? new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }));
    const service = createFileDownloadService({ auth, chooseDestination, fetchFn, idleTimeoutMs: options.idleTimeoutMs });
    return { service, auth, status, chooseDestination, fetchFn, bytes };
  }

  it("streams exact binary bytes to a native destination using captured runtime authentication", async () => {
    const h = harness();
    await expect(h.service.download(request)).resolves.toEqual({ status: "saved" });
    expect(await readFile(join(dir, "report.zip"))).toEqual(Buffer.from(h.bytes));
    expect(await readdir(dir)).toEqual(["report.zip"]);
    expect(h.chooseDestination).toHaveBeenCalledWith("报告 & data.zip");
    const [url, init] = h.fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/files/media");
    expect(new URL(url).searchParams.get("path")).toBe(request.path);
    expect(new URL(url).searchParams.get("runtime")).toBe("preview");
    expect(init.headers).toEqual({ Authorization: "Bearer private-token", "Accept-Encoding": "identity" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not fetch or create files after canceling the save dialog", async () => {
    const h = harness({ destination: null });
    await expect(h.service.download(request)).resolves.toEqual({ status: "cancelled" });
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects stale runtime and auth snapshots before showing a dialog", async () => {
    const h = harness();
    await expect(h.service.download({ ...request, authGeneration: 2 })).resolves.toEqual({ status: "cancelled" });
    await expect(h.service.download({ ...request, runtimeSlot: "primary" })).resolves.toEqual({ status: "cancelled" });
    expect(h.chooseDestination).not.toHaveBeenCalled();
  });

  it("does not switch the file source when the runtime changes during the dialog", async () => {
    const h = harness();
    h.chooseDestination.mockImplementation(async () => {
      h.status.runtimeSlot = "primary";
      return join(dir, "report.zip");
    });
    await expect(h.service.download(request)).resolves.toEqual({ status: "cancelled" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("keeps only one active operation and ignores unrelated cancellation IDs", async () => {
    const h = harness();
    const dialog = deferred<string | null>();
    h.chooseDestination.mockImplementation(() => dialog.promise);
    const first = h.service.download(request);
    await expect(h.service.download({ ...request, requestId: "2a745da3-7551-434e-8947-634928188816" })).resolves.toEqual({ status: "error", code: "busy" });
    expect(h.service.cancel("2a745da3-7551-434e-8947-634928188816")).toEqual({ ok: false });
    expect(h.service.cancel(request.requestId)).toEqual({ ok: true });
    await expect(first).resolves.toEqual({ status: "cancelled" });
    dialog.resolve(join(dir, "report.zip"));
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("does not open a dialog when cancelled in the same tick", async () => {
    const h = harness();
    const result = h.service.download(request);
    h.service.cancel(request.requestId);
    await expect(result).resolves.toEqual({ status: "cancelled" });
    expect(h.chooseDestination).not.toHaveBeenCalled();
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each([true, false])("streams files larger than 10 MiB (known length: %s)", async (known) => {
    const bytes = new Uint8Array(16 * 1024 * 1024 + 7).fill(173);
    const h = harness({ response: new Response(bytes, known ? { headers: { "Content-Length": String(bytes.length) } } : {}) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "saved" });
    expect((await readFile(join(dir, "report.zip"))).equals(Buffer.from(bytes))).toBe(true);
    expect(await readdir(dir)).toEqual(["report.zip"]);
  });

  it("allows a healthy transfer to outlast the inactivity timeout", async () => {
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        controller.enqueue(new Uint8Array([++chunks]));
        if (chunks === 5) controller.close();
      },
    }, { highWaterMark: 0 });
    const h = harness({ response: new Response(stream), idleTimeoutMs: 200 });
    await expect(h.service.download(request)).resolves.toEqual({ status: "saved" });
    expect(await readFile(join(dir, "report.zip"))).toEqual(Buffer.from([1,2,3,4,5]));
  });

  it("times out a stalled body and preserves the previous destination", async () => {
    await writeFile(join(dir, "report.zip"), "original");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
    const h = harness({ response: new Response(stream), idleTimeoutMs: 30 });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(dir)).toEqual(["report.zip"]);
    expect(await readFile(join(dir, "report.zip"), "utf8")).toBe("original");
  });

  it("does not save an unsolicited partial response as a complete file", async () => {
    const h = harness({ response: new Response("part", { status: 206, headers: { "Content-Length": "4", "Content-Range": "bytes 0-3/10" } }) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "failed" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("resumes an interrupted transfer only at the saved offset and same source version", async () => {
    let first = true;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (first) { first = false; controller.enqueue(new Uint8Array([1,2])); }
      else controller.error(new Error("connection interrupted"));
    } }, { highWaterMark: 0 });
    const h = harness();
    h.fetchFn.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Length": "4", ETag: '"source-v1"' } }));
    h.fetchFn.mockResolvedValueOnce(new Response(new Uint8Array([3,4]), { status: 206, headers: { "Content-Length": "2", "Content-Range": "bytes 2-3/4", ETag: '"source-v1"' } }));
    await expect(h.service.download(request)).resolves.toEqual({ status: "saved" });
    expect(await readFile(join(dir, "report.zip"))).toEqual(Buffer.from([1,2,3,4]));
    expect(h.fetchFn).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=2-", "If-Range": '"source-v1"' }) }));
  });

  it("preserves the destination if the remote version changed before resumption", async () => {
    await writeFile(join(dir, "report.zip"), "original");
    const h = harness();
    h.fetchFn.mockResolvedValueOnce(new Response("ab", { headers: { "Content-Length": "4", ETag: '"source-v1"' } }));
    h.fetchFn.mockResolvedValueOnce(new Response("new-file", { headers: { ETag: '"source-v2"' } }));
    expect((await h.service.download(request)).status).toBe("error");
    expect(await readFile(join(dir, "report.zip"), "utf8")).toBe("original");
    expect(await readdir(dir)).toEqual(["report.zip"]);
  });

  it("bounds repeated interruptions without progress", async () => {
    const h = harness();
    h.fetchFn.mockResolvedValueOnce(new Response(null, { headers: { "Content-Length": "4", ETag: '"source-v1"' } }));
    h.fetchFn.mockImplementation(async () => new Response(null, { status: 206, headers: { "Content-Length": "4", "Content-Range": "bytes 0-3/4", ETag: '"source-v1"' } }));
    expect((await h.service.download(request)).status).toBe("error");
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not treat a local disk write failure as a resumable network interruption", async () => {
    const probe = await open(join(dir, "probe"), "wx");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    await rm(join(dir, "probe"));
    const write = vi.spyOn(prototype, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    try {
      const h = harness({ response: new Response("data", { headers: { "Content-Length": "8", ETag: '"source-v1"' } }) });
      expect((await h.service.download(request)).status).toBe("error");
      expect(h.fetchFn).toHaveBeenCalledOnce();
      expect(await readdir(dir)).toEqual([]);
    } finally { write.mockRestore(); }
  });

  it("does not publish a truncated response", async () => {
    const h = harness({ response: new Response("partial", { headers: { "Content-Length": "20" } }) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "failed" });
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([401, 403, 404, 500])("returns bounded error copy for HTTP %i without writing an error body", async (status) => {
    const h = harness({ response: new Response("private server detail", { status }) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: status === 500 ? "failed" : "unavailable" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("atomically replaces a destination chosen and confirmed in the native save dialog", async () => {
    await writeFile(join(dir, "report.zip"), "old");
    const h = harness();
    await expect(h.service.download(request)).resolves.toEqual({ status: "saved" });
    expect(await readFile(join(dir, "report.zip"))).toEqual(Buffer.from(h.bytes));
    expect(await readdir(dir)).toEqual(["report.zip"]);
  });

  it("preserves an existing destination when the network fails", async () => {
    await writeFile(join(dir, "report.zip"), "old");
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("connection failed /private/server")); } });
    const h = harness({ response: new Response(stream) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "failed" });
    expect(await readFile(join(dir, "report.zip"), "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["report.zip"]);
  });

  it("does not overwrite a file that appeared while downloading", async () => {
    const h = harness();
    h.fetchFn.mockImplementation(async () => {
      await writeFile(join(dir, "report.zip"), "another app");
      return new Response("download");
    });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "destination_changed" });
    expect(await readFile(join(dir, "report.zip"), "utf8")).toBe("another app");
    expect(await readdir(dir)).toEqual(["report.zip"]);
  });

  it("cleans up a partial file and drains shutdown while a stream is pending", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new Uint8Array([1, 2])); } });
    const h = harness({ response: new Response(stream) });
    const download = h.service.download(request);
    await vi.waitFor(() => expect(h.fetchFn).toHaveBeenCalledOnce());
    await h.service.dispose();
    await expect(download).resolves.toEqual({ status: "cancelled" });
    expect(await readdir(dir)).toEqual([]);
    expect(() => controller.close()).toThrow();
  });

  it("returns a generic failure for an unwritable destination without a partial file", async () => {
    const h = harness({ destination: join(dir, "missing", "report.zip") });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "failed" });
    expect(await readdir(dir)).toEqual([]);
  });
});
