import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGatewayChatAdapters } from "../../packages/gateway/src/server/canonical-chat-adapters.js";
import { executableChatDrivers } from "../../packages/gateway/src/server/provider-discovery-composition.js";

describe("OpenClaw canonical Chat production wiring", () => {
  it("keeps catalog executability and adapter registration connected", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    const gatewayComposition = readFileSync(join(process.cwd(), "packages/gateway/src/server/canonical-chat-adapters.ts"), "utf8");
    const adapterComposition = readFileSync(join(process.cwd(), "packages/gateway/src/server/initial-chat-adapters.ts"), "utf8");
    const importAdapterComposition = source.indexOf('import { createGatewayChatAdapters, type GatewayNativeClaudeChatRuntime } from "./server/canonical-chat-adapters.js"');
    const executableKinds = source.indexOf("const canonicalExecutableDriverKinds = executableChatDrivers(codingAgentProviders, Boolean(codingAgentThreadStore))");
    const adapterList = source.indexOf("const chatAdapters = createGatewayChatAdapters({", executableKinds);
    const registry = source.indexOf("new CanonicalChatProviderRegistry(chatAdapters.adapters.map(adapter => withAsyncChatInput(adapter)))", adapterList);
    const importInitialAdapters = gatewayComposition.indexOf('import { createInitialChatAdapters } from "./initial-chat-adapters.js"');
    const initialAdapters = gatewayComposition.indexOf("const adapters = createInitialChatAdapters(options.initial)", importInitialAdapters);
    const importAdapter = adapterComposition.indexOf('import { createOpenClawChatProviderAdapter } from "../chat/openclaw-provider-adapter.js"');
    const registeredAdapter = adapterComposition.indexOf("createOpenClawChatProviderAdapter({", importAdapter);

    expect(importAdapterComposition).toBeGreaterThan(-1);
    expect(executableKinds).toBeGreaterThan(importAdapterComposition);
    expect(executableChatDrivers([], false)).toContain("openclaw");
    expect(executableChatDrivers([{ providerId: "codex" }], true)).toContain("openclaw");
    expect(adapterList).toBeGreaterThan(executableKinds);
    expect(registry).toBeGreaterThan(adapterList);
    expect(importInitialAdapters).toBeGreaterThan(-1);
    expect(initialAdapters).toBeGreaterThan(importInitialAdapters);
    expect(importAdapter).toBeGreaterThan(-1);
    expect(registeredAdapter).toBeGreaterThan(importAdapter);
  });

  it("retains the real OpenClaw adapter through gateway composition without starting inference", () => {
    const dispatch = vi.fn();
    const rpc = { call: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const runtime = createGatewayChatAdapters({
      initial: { homePath: "/tmp/matrix-openclaw-wiring", dispatcher: { dispatch }, rpc, gatewayPort: 4000 },
      providers: [], threads: undefined, claude: {},
    });

    expect(runtime.adapters.filter(adapter => adapter.driverKind === "openclaw")).toHaveLength(1);
    expect(runtime.nativeClaude).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
