import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { buildKernelEnv } from "../../packages/gateway/src/kernel-credentials.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Real owner credentials for CLI regression tests; no ambient platform fallback. */
export function ownerSdkHomeFixture(): () => string {
  let homePath: string;
  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "owner-sdk-fixture-"));
    mkdirSync(join(homePath, "system"));
    writeFileSync(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-test-key" } }));
  });
  afterEach(() => rmSync(homePath, { recursive: true, force: true }));
  return () => homePath;
}

/** Keep display/path fixtures stable while exercising real owner credential resolution. */
export function ownerSdkAdapterFixture(): typeof createClaudeChatProviderAdapter {
  const home = ownerSdkHomeFixture();
  return (options) => createClaudeChatProviderAdapter({
    resolveCredentialEnv: () => buildKernelEnv(home(), {}, "owner_anthropic_key"),
    ...options,
  });
}
