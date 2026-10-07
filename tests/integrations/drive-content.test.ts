import { describe, expect, it, vi } from "vitest";
import { createDriveContentReader, DriveContentError, DRIVE_CONTENT_MAX_BYTES } from "../../packages/gateway/src/integrations/drive-content.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const identity = { externalUserId: "owner", accountId: "apn_drive", fileId: "file_123" };
function setup(responses: Response[]) {
  const fetcher = vi.fn(async () => responses.shift()!);
  const read = createDriveContentReader({ projectId: "proj_test", environment: "production", getAccessToken: async () => "private-token", fetcher });
  const targets = () => fetcher.mock.calls.map(([url]: [string, RequestInit]) => new URL(Buffer.from(new URL(url).pathname.split("/").at(-1)!, "base64url").toString()));
  return { read, fetcher, targets };
}
const text = (content: string, type = "text/markdown") => new Response(content, { headers: { "Content-Type": type } });
const metadata = (mimeType: string) => Response.json({ id: "file_123", name: "Notes", mimeType, capabilities: { canDownload: true } });

describe("Drive file content", () => {
  it("reads uploaded Markdown without parsing it as JSON, with one proxy call when MIME is known", async () => {
    const { read, fetcher, targets } = setup([text("# Notes\nActual content")]);
    expect(await read({ ...identity, mimeType: "text/markdown" })).toMatchObject({ fileId: "file_123", content: "# Notes\nActual content", mimeType: "text/markdown" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(targets()[0].searchParams.get("alt")).toBe("media");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get("external_user_id")).toBe("owner");
    expect(new URL(url).searchParams.get("account_id")).toBe("apn_drive");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("discovers the MIME type and exports Google Docs as Markdown", async () => {
    const { read, targets } = setup([metadata("application/vnd.google-apps.document"), text("# Document")]);
    expect(await read(identity)).toMatchObject({ content: "# Document", mimeType: "text/markdown", name: "Notes" });
    expect(targets()).toHaveLength(2);
    expect(targets()[1].pathname).toBe("/drive/v3/files/file_123/export");
    expect(targets()[1].searchParams.get("mimeType")).toBe("text/markdown");
  });
  it.each([
    ["application/vnd.google-apps.document", "text/plain"],
    ["application/vnd.google-apps.spreadsheet", "text/csv"],
    ["application/vnd.google-apps.presentation", "text/plain"],
  ])("supports an explicit text export for %s", async (mimeType, exportMimeType) => {
    const { read, targets } = setup([text("content", exportMimeType)]);
    await read({ ...identity, mimeType, exportMimeType });
    expect(targets()[0].searchParams.get("mimeType")).toBe(exportMimeType);
  });
  it.each(["../file", "a/b", "", "x".repeat(257)])("rejects invalid IDs before making a billable request", async (fileId) => {
    const { read, fetcher } = setup([]);
    await expect(read({ ...identity, fileId })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unsupported binary/Google Workspace files instead of returning metadata as content", async () => {
    const { read, fetcher } = setup([]);
    for (const mimeType of ["application/pdf", "image/png", "application/vnd.google-apps.folder"]) {
      await expect(read({ ...identity, mimeType })).rejects.toMatchObject({ code: "unsupported_file_type" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not bypass download restrictions", async () => {
    const { read, fetcher } = setup([Response.json({ mimeType: "text/plain", capabilities: { canDownload: false } })]);
    await expect(read(identity)).rejects.toMatchObject({ code: "file_access_denied" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("caps streamed bytes even without Content-Length and cancels oversized data", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(DRIVE_CONTENT_MAX_BYTES + 1)); }, cancel });
    const { read } = setup([new Response(body, { headers: { "Content-Type": "text/plain" } })]);
    await expect(read({ ...identity, mimeType: "text/plain" })).rejects.toMatchObject({ code: "file_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("accepts small files delivered in more than 4096 chunks", async () => {
    let count = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (count++ < 6000) controller.enqueue(new Uint8Array([97]));
      else controller.close();
    } });
    const { read } = setup([new Response(body, { headers: { "Content-Type": "text/plain" } })]);
    expect(await read({ ...identity, mimeType: "text/plain" })).toMatchObject({ content: "a".repeat(6000), bytes: 6000 });
  });
  it("rejects invalid UTF-8 and binary responses", async () => {
    const { read } = setup([new Response(new Uint8Array([255]), { headers: { "Content-Type": "text/plain" } }), text("hello\u0000world")]);
    await expect(read({ ...identity, mimeType: "text/plain" })).rejects.toBeInstanceOf(DriveContentError);
    await expect(read({ ...identity, mimeType: "text/plain" })).rejects.toMatchObject({ code: "unsupported_file_type" });
  });
  it.each([[403, "file_access_denied"], [404, "file_not_found"], [429, "rate_limited"]])("maps %s safely without exposing upstream bodies", async (status, code) => {
    const { read, fetcher } = setup([new Response("secret provider details", { status })]);
    await expect(read({ ...identity, mimeType: "text/plain" })).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("coalesces concurrent identical reads, isolates owners/accounts, and refreshes after completion", async () => {
    let release!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const read = createDriveContentReader({ projectId: "proj_test", environment: "production", getAccessToken: async () => "token", fetcher });
    const a = read({ ...identity, mimeType: "text/plain" });
    const b = read({ ...identity, mimeType: "text/plain" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    release(text("first", "text/plain"));
    expect((await Promise.all([a, b])).map(x => x.content)).toEqual(["first", "first"]);
    fetcher.mockImplementation(async () => text("fresh", "text/plain"));
    await read({ ...identity, mimeType: "text/plain" });
    await read({ ...identity, externalUserId: "other", mimeType: "text/plain" });
    await read({ ...identity, accountId: "apn_other", mimeType: "text/plain" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("routes the catalog action through the owner-bound content reader, never the JSON proxy or discovered component", async () => {
    const readDriveFile = vi.fn().mockResolvedValue({ content: "# actual file" });
    const proxyGet = vi.fn(); const runAction = vi.fn();
    const def = getService("google_drive")!;
    const actionDef = def.actions.read_file;
    expect(actionDef).toBeDefined();
    const result = await executeIntegrationAction({ pipedream: { readDriveFile, proxyGet, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "apn_drive" }, def, actionDef, serviceId: "google_drive", actionId: "read_file", params: { fileId: "file_123", mimeType: "text/markdown" } });
    expect(result.data).toEqual({ content: "# actual file" });
    expect(readDriveFile).toHaveBeenCalledWith({ ...identity, mimeType: "text/markdown" });
    expect(proxyGet).not.toHaveBeenCalled(); expect(runAction).not.toHaveBeenCalled();
  });
  it.each(["fetch", "body", "metadata-budget"])("enforces the shared deadline for a stalled %s", async (stage) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([97])); }, cancel });
      const fetcher = vi.fn((_url: string, _init: RequestInit): Promise<Response> => {
        if (stage === "fetch") return new Promise(() => {});
        if (stage === "metadata-budget" && fetcher.mock.calls.length === 1) {
          return new Promise(resolve => setTimeout(() => resolve(metadata("text/plain")), 20_000));
        }
        return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/plain" } }));
      });
      const read = createDriveContentReader({ projectId: "proj_test", environment: "production", getAccessToken: async () => "token", fetcher });
      let settled = false;
      const result = read(stage === "metadata-budget" ? identity : { ...identity, mimeType: "text/plain" })
        .then(value => ({ value, error: null }), error => ({ value: null, error }));
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await result).error).toBeInstanceOf(DriveContentError);
      expect(fetcher).toHaveBeenCalledTimes(stage === "metadata-budget" ? 2 : 1);
      for (const [, init] of fetcher.mock.calls) expect(init.signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(stage === "fetch" ? 0 : 1);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it("bounds a hung token lookup before issuing any provider call", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    try {
      const fetcher = vi.fn();
      const read = createDriveContentReader({ projectId: "proj_test", environment: "production", getAccessToken: () => new Promise(() => {}), fetcher });
      const result = expect(read({ ...identity, mimeType: "text/plain" })).rejects.toBeInstanceOf(DriveContentError);
      await vi.advanceTimersByTimeAsync(30_001); await result;
      expect(fetcher).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
});
