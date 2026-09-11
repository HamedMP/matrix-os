import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  function harness(options: { response?: Response; destination?: string | null } = {}) {
    const status = { signedIn: true, runtimeSlot: "preview", authGeneration: 3 };
    const auth = {
      getToken: vi.fn(() => "private-token"),
      getGatewayOrigin: () => "https://app.matrix-os.com",
      getStatus: () => status,
    };
    const chooseDestination = vi.fn(async () => options.destination === undefined ? join(dir, "report.zip") : options.destination);
    const bytes = new Uint8Array([0, 255, 10, 128, 0]);
    const fetchFn = vi.fn(async () => options.response ?? new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }));
    const service = createFileDownloadService({ auth, chooseDestination, fetchFn });
    return { service, auth, status, chooseDestination, fetchFn, bytes };
  }

  it("streams exact binary bytes to a native destination using captured runtime authentication", async () => {
    const h = harness();
    await expect(h.service.download(request)).resolves.toEqual({ status: "saved" });
    expect(await readFile(join(dir, "report.zip"))).toEqual(Buffer.from(h.bytes));
    expect(await readdir(dir)).toEqual(["report.zip"]);
    expect(h.chooseDestination).toHaveBeenCalledWith("报告 & data.zip");
    const [url, init] = h.fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/files/blob");
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

  it("rejects oversized response headers without publishing a file", async () => {
    const h = harness({ response: new Response("x", { headers: { "Content-Length": String(10 * 1024 * 1024 + 1) } }) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "too_large" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("enforces the actual streamed byte limit even without content-length", async () => {
    const h = harness({ response: new Response(new Uint8Array(10 * 1024 * 1024 + 1)) });
    await expect(h.service.download(request)).resolves.toEqual({ status: "error", code: "too_large" });
    expect(await readdir(dir)).toEqual([]);
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
