import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executableChatDrivers } from "../../packages/gateway/src/server/provider-discovery-composition.js";

describe("OpenClaw canonical Chat production wiring", () => {
  it("keeps catalog executability and adapter registration connected", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    const importAdapter = source.indexOf("createOpenClawChatProviderAdapter");
    const executableKinds = source.indexOf("const canonicalExecutableDriverKinds = executableChatDrivers(codingAgentProviders, Boolean(codingAgentThreadStore))");
    const adapterList = source.indexOf("const canonicalAdapters:", executableKinds);
    const registeredAdapter = source.indexOf("createOpenClawChatProviderAdapter({", adapterList);

    expect(importAdapter).toBeGreaterThan(-1);
    expect(executableKinds).toBeGreaterThan(importAdapter);
    expect(executableChatDrivers([], false)).toContain("openclaw");
    expect(executableChatDrivers([{ providerId: "codex" }], true)).toContain("openclaw");
    expect(adapterList).toBeGreaterThan(executableKinds);
    expect(registeredAdapter).toBeGreaterThan(adapterList);
  });
});
