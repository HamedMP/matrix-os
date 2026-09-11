import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenClaw canonical Chat production wiring", () => {
  it("keeps catalog executability and adapter registration connected", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    const importAdapter = source.indexOf("createOpenClawChatProviderAdapter");
    const executableKinds = source.indexOf("const canonicalExecutableDriverKinds = [");
    const executableOpenClaw = source.indexOf('"openclaw" as const', executableKinds);
    const adapterList = source.indexOf("const canonicalAdapters:", executableOpenClaw);
    const registeredAdapter = source.indexOf("createOpenClawChatProviderAdapter({", adapterList);

    expect(importAdapter).toBeGreaterThan(-1);
    expect(executableKinds).toBeGreaterThan(importAdapter);
    expect(executableOpenClaw).toBeGreaterThan(executableKinds);
    expect(adapterList).toBeGreaterThan(executableOpenClaw);
    expect(registeredAdapter).toBeGreaterThan(adapterList);
  });
});
