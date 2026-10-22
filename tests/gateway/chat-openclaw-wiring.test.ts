import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executableChatDrivers } from "../../packages/gateway/src/server/provider-discovery-composition.js";

describe("OpenClaw canonical Chat production wiring", () => {
  it("keeps catalog executability and adapter registration connected", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    const adapterComposition = readFileSync(join(process.cwd(), "packages/gateway/src/server/initial-chat-adapters.ts"), "utf8");
    const importAdapterComposition = source.indexOf('import { createInitialChatAdapters } from "./server/initial-chat-adapters.js"');
    const executableKinds = source.indexOf("const canonicalExecutableDriverKinds = executableChatDrivers(codingAgentProviders, Boolean(codingAgentThreadStore))");
    const adapterList = source.indexOf("const canonicalAdapters = createInitialChatAdapters({", executableKinds);
    const importAdapter = adapterComposition.indexOf('import { createOpenClawChatProviderAdapter } from "../chat/openclaw-provider-adapter.js"');
    const registeredAdapter = adapterComposition.indexOf("createOpenClawChatProviderAdapter({", importAdapter);

    expect(importAdapterComposition).toBeGreaterThan(-1);
    expect(executableKinds).toBeGreaterThan(importAdapterComposition);
    expect(executableChatDrivers([], false)).toContain("openclaw");
    expect(executableChatDrivers([{ providerId: "codex" }], true)).toContain("openclaw");
    expect(adapterList).toBeGreaterThan(executableKinds);
    expect(importAdapter).toBeGreaterThan(-1);
    expect(registeredAdapter).toBeGreaterThan(importAdapter);
  });
});
