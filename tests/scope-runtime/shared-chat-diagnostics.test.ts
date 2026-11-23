import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScopeRuntimeBrokerServer, createScopeRuntimeBroker } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { ScopeRuntimeBrokerRequestSchema } from "../../packages/scope-runtime/src/broker-protocol.js";
import { startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { parseScopeCodexJsonEvents } from "../../packages/scope-runtime/src/worker.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const runtimeHandle = `runtime_${"d".repeat(32)}`;
const privateDetail = "private prompt bearer-owner-secret";
afterEach(() => vi.restoreAllMocks());

describe("shared Chat failure diagnostics without content", () => {
  it.each([
    { lines: [JSON.stringify({ type: "turn.failed", error: { message: privateDetail } })], code: "turn_failed" },
    { lines: [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: privateDetail } })], code: "incomplete_turn" },
    { lines: [privateDetail], code: "invalid_event" },
  ])("preserves the $code boundary instead of erasing it to Error", ({ lines, code }) => {
    let failure: unknown;
    try { parseScopeCodexJsonEvents(lines); } catch (error: unknown) { failure = error; }
    expect(failure).toMatchObject({ code, message: "Codex result unavailable" });
    expect(JSON.stringify(failure)).not.toContain(privateDetail);
  });

  it("records upstream refusal status without copying response or owner identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broker = createScopeRuntimeBroker({
      homePath: "/home/matrix/home",
      authorize: async () => ({ allowed: true, providerIdentity: { driverKind: "codex", instanceId: "codex_default" },
        allowedModelIds: ["test-model"], allowedEgressOrigins: [] }),
      resolveCodexIdentity: async () => ({ url: "https://chatgpt.com/backend-api/codex/responses",
        headers: { authorization: "Bearer owner-secret", "chatgpt-account-id": "private-account" } }),
      fetchImpl: async () => new Response(privateDetail, { status: 403 }),
    });
    try {
      const reply = await broker.handle(ScopeRuntimeBrokerRequestSchema.parse({ version: 1, action: "inference.responses",
        requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle, executionGeneration: "1",
        method: "POST", path: "/v1/responses", headers: {},
        body: JSON.stringify({ model: "test-model", stream: true, input: [] }) }));
      expect(reply).toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(warn).toHaveBeenCalledWith("[collaboration] shared Codex upstream unavailable", { status: 403 });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/owner-secret|private-account|private prompt/);
    } finally { await broker.close(); }
  });

  it.each(["action_denied", "provider_unavailable"] as const)(
    "records only an allowlisted broker refusal across the real bridge: %s", async error => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const directory = await createUnixSocketTempDir();
      const broker = createScopeRuntimeBrokerServer({ socketPath: join(directory, "broker.sock"),
        broker: { handle: async request => ({ version: 1, requestId: request.requestId, ok: false, error }),
          close: async () => undefined } });
      let bridge: Awaited<ReturnType<typeof startInferenceBridge>> | undefined;
      try {
        await broker.start();
        bridge = await startInferenceBridge({ brokerSocket: join(directory, "broker.sock"), runtimeHandle,
          executionGeneration: "1", actionFor: () => "inference.responses" });
        const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, { method: "POST",
          body: JSON.stringify({ model: "test-model", stream: true, input: [] }), signal: AbortSignal.timeout(3000) });
        expect(response.status).toBe(502);
        await response.body?.cancel();
        expect(warn).toHaveBeenCalledWith("[scope-runtime] inference broker refused", {
          code: error,
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(privateDetail);
      } finally {
        await bridge?.close(); await broker.close(); await rm(directory, { recursive: true, force: true });
      }
    });
});
