import { describe, expect, it } from "vitest";

import { createIntegrationProxyResponse } from "../../packages/gateway/src/integrations/proxy-response.js";

describe("integration proxy response", () => {
  it("removes decoded representation and hop-by-hop headers", async () => {
    const upstream = new Response(JSON.stringify([{ service: "gmail" }]), {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        connection: "keep-alive",
        "content-encoding": "gzip",
        "content-length": "999",
        "content-type": "application/json",
        "keep-alive": "timeout=5",
        "proxy-authenticate": "Basic",
        "proxy-authorization": "Basic secret",
        te: "trailers",
        trailer: "x-checksum",
        trailers: "x-checksum",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
      },
    });

    const response = createIntegrationProxyResponse(upstream);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    for (const name of [
      "connection",
      "content-encoding",
      "content-length",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "trailers",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(response.headers.get(name), name).toBeNull();
    }
    await expect(response.json()).resolves.toEqual([{ service: "gmail" }]);
  });
});
