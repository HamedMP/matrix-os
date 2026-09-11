import { describe, expect, it, vi } from "vitest";
import { registerIpcHandlers, type HandlerContext } from "../../desktop/src/main/ipc/handlers";

function harness() {
  const listeners: Record<string, (event: unknown, request: unknown) => Promise<unknown>> = {};
  const downloadFile = vi.fn(async () => ({ status: "saved" }));
  const cancelFileDownload = vi.fn(() => ({ ok: true }));
  const ctx = { buildSource: null, downloadFile, cancelFileDownload } as unknown as HandlerContext;
  registerIpcHandlers({ handle(channel, listener) { listeners[channel] = listener as typeof listeners[string]; } }, ctx);
  return { listeners, downloadFile, cancelFileDownload };
}
const request = { path: "data.bin", requestId: "1a745da3-7551-434e-8947-634928188816", runtimeSlot: "primary", authGeneration: 1 };
describe("download IPC registration", () => {
  it("routes only validated requests to the trusted service", async () => {
    const h = harness();
    await expect(h.listeners["runtime:download-file"]!({}, request)).resolves.toEqual({ status: "saved" });
    expect(h.downloadFile).toHaveBeenCalledWith(request);
    await expect(h.listeners["runtime:download-file"]!({}, { ...request, destination: "/tmp/arbitrary" })).rejects.toThrow("invalid request");
    await expect(h.listeners["runtime:cancel-file-download"]!({}, { requestId: request.requestId })).resolves.toEqual({ ok: true });
    expect(h.cancelFileDownload).toHaveBeenCalledWith(request.requestId);
  });
  it("rejects registration when download dependencies are missing", () => {
    expect(() => registerIpcHandlers({ handle: vi.fn() }, { buildSource: null } as unknown as HandlerContext)).toThrow("download service unavailable");
  });
});
