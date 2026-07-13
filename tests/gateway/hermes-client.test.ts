import { describe, expect, it, vi } from "vitest";
import {
  createHermesDashboardClient,
} from "../../packages/gateway/src/agent-config/hermes-client.js";

describe("Hermes dashboard client", () => {
  it("forwards the caller signal and rejects oversized JSON responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
      { headers: { "content-type": "application/json" } },
    ));
    const client = createHermesDashboardClient({
      baseUrl: "http://127.0.0.1:9119",
      fetchImpl,
    });
    const signal = new AbortController().signal;

    await expect(client.readJson("/api/status", signal)).rejects.toMatchObject({
      name: "HermesResponseTooLargeError",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/status",
      expect.objectContaining({ signal, redirect: "error" }),
    );
  });
});
