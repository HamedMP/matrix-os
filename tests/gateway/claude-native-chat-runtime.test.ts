import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  pool: { runTurn: vi.fn(), setScheduledHandler: vi.fn(), cancel: vi.fn(), close: vi.fn(async () => {}) },
  createPool: vi.fn(),
  createInitial: vi.fn(),
  createCoding: vi.fn(),
}));
vi.mock("../../packages/gateway/src/chat/claude-native-session.js", () => ({ createClaudeNativeSessionPool: mocks.createPool }));
vi.mock("../../packages/gateway/src/server/initial-chat-adapters.js", () => ({ createInitialChatAdapters: mocks.createInitial }));
vi.mock("../../packages/gateway/src/chat/coding-provider-adapter.js", () => ({ createCanonicalCodingChatProviderAdapter: mocks.createCoding }));
import { createGatewayClaudeChatRuntime } from "../../packages/gateway/src/chat/claude-native-chat-runtime.js";
import { createGatewayChatAdapters } from "../../packages/gateway/src/server/canonical-chat-adapters.js";

describe("gateway Claude native session composition", () => {
  it("creates the explicitly qualified transport and binds only the private current orchestrator", async () => {
    mocks.createPool.mockReturnValue(mocks.pool);
    const runtime = createGatewayClaudeChatRuntime({ homePath: "/owner" });
    expect(mocks.createPool).toHaveBeenCalledWith({ protocolQualified: true });
    const admitNativeScheduledPhase = vi.fn(async () => {});
    let current: { admitNativeScheduledPhase: typeof admitNativeScheduledPhase } | null = { admitNativeScheduledPhase };
    runtime.bind(() => current);
    const handler = mocks.pool.setScheduledHandler.mock.calls.at(-1)![0];
    const request = { owner: { type: "personal", ownerId: "owner_a" }, chatId: "chat_a", sourceRunId: "run_a", sessionId: "native_a", promptId: "prompt_a", prompt: "due" };
    await handler(request);
    expect(admitNativeScheduledPhase).toHaveBeenCalledExactlyOnceWith(request);
    current = null;
    await expect(handler(request)).rejects.toThrow("Native scheduled Chat unavailable");
    expect(admitNativeScheduledPhase).toHaveBeenCalledOnce();
    await runtime.close(); expect(mocks.pool.close).toHaveBeenCalledOnce();
  });

  it("keeps provider registration order and existing routine/browser dependencies", () => {
    mocks.createPool.mockReturnValue(mocks.pool);
    const initialAdapter = { driverKind: "kernel" };
    const botAdapter = { driverKind: "bot" };
    const managedBotAdapter = { driverKind: "matrix_pi" };
    mocks.createInitial.mockReturnValue([initialAdapter]);
    mocks.createCoding.mockImplementation(options => ({ driverKind: options.providerId }));
    const routineCli = { runtime: {}, binPath: "/matrix", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute" };
    const sharedBrowser = {};
    const providers = ["opencode", "claude", "pi", "codex"].map(providerId => ({ providerId }));
    const initial = { homePath: "/owner", dispatcher: {}, rpc: {}, gatewayPort: 4000, routineCli, sharedBrowser };
    const result = createGatewayChatAdapters({ initial, providers, threads: {}, claude: {}, botAdapter, managedBotAdapter } as unknown as Parameters<typeof createGatewayChatAdapters>[0]);
    expect(mocks.createInitial).toHaveBeenCalledWith(initial);
    expect(result.adapters.map(adapter => adapter.driverKind)).toEqual(["kernel", "claude_code", "codex", "pi", "opencode", "bot", "matrix_pi"]);
    expect(result.nativeClaude?.adapter).toBe(result.adapters[1]);
    const codingCalls = mocks.createCoding.mock.calls.slice(-3).map(([options]) => options);
    expect(codingCalls[0]).toMatchObject({ providerId: "codex", routineCli, sharedBrowser, gatewayPort: 4000 });
    for (const options of codingCalls.slice(1)) {
      expect(options.routineCli).toBe(routineCli);
      expect(options).not.toHaveProperty("sharedBrowser");
      expect(options).not.toHaveProperty("gatewayPort");
    }
  });
});
