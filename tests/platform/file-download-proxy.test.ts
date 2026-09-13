import { describe, expect, it, vi } from "vitest";
import { sanitizeProxyResponseHeaders } from "../../packages/platform/src/proxy-headers";
import { buildAppDomainProxyResponse } from "../../packages/platform/src/session-routing-proxy";

describe("attachment download proxy metadata", () => {
  it("preserves exact uncompressed attachment length and validators without reading the body", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new Uint8Array([1,2,3])); controller.close(); });
    const upstream = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { status: 206, headers: {
      "Content-Length": "3", "Content-Range": "bytes 3-5/6", ETag: '"file-v1"', "Content-Disposition": 'attachment; filename="file.bin"', "Content-Type": "application/octet-stream",
    } });
    const response = await buildAppDomainProxyResponse({ upstream, responseHeaders: sanitizeProxyResponseHeaders(upstream.headers), path: "/api/files/media", handle: "fixture", runtimeSlot: "primary", platformSecret: "fixture-secret" });
    expect(pull).not.toHaveBeenCalled();
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-range")).toBe("bytes 3-5/6");
    expect(response.headers.get("etag")).toBe('"file-v1"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
  });
  it.each(["gzip", "br"])("never restores encoded wire length for a decoded %s body", async (encoding) => {
    const upstream = new Response("decoded", { headers: { "Content-Length": "100", "Content-Encoding": encoding, "Content-Disposition": "attachment" } });
    const response = await buildAppDomainProxyResponse({ upstream, responseHeaders: sanitizeProxyResponseHeaders(upstream.headers), path: "/api/files/media", handle: "fixture", runtimeSlot: "primary", platformSecret: "fixture-secret" });
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("decoded");
  });
  it("keeps ordinary media preview sanitization unchanged", async () => {
    const upstream = new Response("media", { headers: { "Content-Length": "5", "Content-Type": "video/mp4" } });
    const response = await buildAppDomainProxyResponse({ upstream, responseHeaders: sanitizeProxyResponseHeaders(upstream.headers), path: "/api/files/media", handle: "fixture", runtimeSlot: "primary", platformSecret: "fixture-secret" });
    expect(response.headers.get("content-length")).toBeNull();
    await response.body!.cancel();
  });
});
