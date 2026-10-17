import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay-config.js";
import { FUNDED_GLM_FLASH } from "../../packages/proxy/src/funded-relay-model.js";
import { FUNDED_SONNET, probeFundedModel } from "../../packages/proxy/src/funded-relay-readiness.js";

describe("standalone funded readiness connections", () => {
  it.each([FUNDED_GLM_FLASH, FUNDED_SONNET])("releases the %s connection instead of retaining an idle socket", async (model) => {
    const sockets = new Set<Socket>();
    const observedConnections: Socket[] = [];
    const server = createServer((request, response) => {
      observedConnections.push(request.socket);
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(model === FUNDED_GLM_FLASH
        ? { success: true, result: { model, choices: [{ message: { content: "ok" } }] } }
        : { type: "message", model: "claude-sonnet-5", content: [] }));
    });
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
        CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
        CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
        PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32),
        AI_RELAY_METADATA_SECRET: "m".repeat(32) })!;
      const transport: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init);
      expect(await probeFundedModel(config, model, transport)).toBe(true);
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000, interval: 10 });
      expect(await probeFundedModel(config, model, transport)).toBe(true);
      expect(observedConnections).toHaveLength(2);
      expect(observedConnections[0]).not.toBe(observedConnections[1]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
