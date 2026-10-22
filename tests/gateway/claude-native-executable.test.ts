import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { buildAgentRuntimeEnvironment } from "../../packages/gateway/src/agent-launcher.js";
import { createClaudeNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";

import { createClaudeSettingsLogin } from "../../packages/gateway/src/ai-providers/provider-workflow-browser.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { claudeNativeTerminalCommand } from "../../packages/gateway/src/ai-providers/claude-native-executable.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-native 'executable-")); roots.push(root);
  const home = join(root, "owner"), prefix = join(root, "runtime");
  const local = join(home, ".local/bin/claude"), managed = join(prefix, "bin/claude");
  await mkdir(join(home, ".local/bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(prefix, "bin"), { recursive: true });
  vi.stubEnv("MATRIX_NODE_PREFIX", prefix);
  vi.stubEnv("PATH", join(home, ".local/bin"));
  const install = async (path: string, profile: "exact" | "missing" | "foreign") => {
    const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "fixture@example.invalid", subscriptionType: "max",
      ...(profile === "missing" ? {} : { configDirectory: profile === "exact" ? join(home, ".claude") : "/foreign/.claude" }) };
    await writeFile(path, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.HOME+'/calls', JSON.stringify({ executable: process.argv[1], args: process.argv.slice(2) })+'\\n');
if (process.argv[3] === 'login') console.log('https://claude.com/cai/oauth/authorize?state=fixture');
else if (process.argv[3] === 'status') console.log(JSON.stringify(${JSON.stringify(status)}));
`, { mode: 0o700 });
  };
  await install(local, "missing");
  await install(managed, "exact");
  const read = () => createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: home, environment: buildAgentRuntimeEnvironment(home), usageReader: async () => null })();
  return { home, local, managed, install, read };
}
it("recognizes the owner with an older local CLI ahead of the managed CLI", async () => {
  const f = await fixture();
  expect((await f.read())?.accountLabel).toBe("fixture@example.invalid");
});
it("never substitutes the owner profile when the selected managed CLI reports another profile", async () => {
  const f = await fixture(); await f.install(f.managed, "foreign"); await f.install(f.local, "exact");
  expect(await f.read()).toBeNull();
});
it("uses a supported owner installation when no managed executable exists", async () => {
  const f = await fixture(); await rm(f.managed); await f.install(f.local, "exact");
  expect((await f.read())?.accountLabel).toBe("fixture@example.invalid");
});
it("does not manufacture profile proof for an older fallback installation", async () => {
  const f = await fixture(); await rm(f.managed);
  expect(await f.read()).toBeNull();
});
it("skips a non-executable managed file and remains unavailable when every executable is absent", async () => {
  const f = await fixture(); await chmod(f.managed, 0o600); await f.install(f.local, "exact");
  expect((await f.read())?.accountLabel).toBe("fixture@example.invalid");
  await rm(f.local); expect(await f.read()).toBeNull();
});

it("uses the managed executable for browser login and completion status", async () => {
  const f = await fixture(); const release = vi.fn(); const publish = vi.fn();
  const login = createClaudeSettingsLogin({ command: "claude", cwd: f.home, env: buildAgentRuntimeEnvironment(f.home), acquire: async () => release });
  await login({ publish, onSuccess: async () => { expect((await f.read())?.accountLabel).toBe("fixture@example.invalid"); } });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null }), { timeout: 3000 });
  expect(release).toHaveBeenCalledOnce();
  const calls = (await readFile(join(f.home, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.args)).toEqual([["auth", "login", "--claudeai"], ["auth", "status", "--json"]]);
  expect(calls.every(call => call.executable === f.managed)).toBe(true);
});
it("uses the same managed executable for lifecycle proof and logout", async () => {
  const f = await fixture(); const metadata = await f.read(); expect(metadata).not.toBeNull();
  const guard = createNativeProviderProfileGuard({ homePath: f.home, registry: { listProfileSessions: async () => [], get: vi.fn(), observeAgentLiveness: async () => "stopped" } });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath: f.home, enabledHarnesses: ["claude"], profileGuard: guard });
  await lifecycle.logout({ account: { id: "owner_claude_profile", providerId: "anthropic", driverId: "claude_code", harness: "claude", authMethod: "terminal", accessSourceId: "owner_claude_profile", installState: "installed", driverAccountCount: 1, authenticated: true, nativeClaudeAccount: metadata! }, idempotencyKey: "dual-install-logout" });
  const calls = (await readFile(join(f.home, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.at(-1).args).toEqual(["auth", "logout"]);
  expect(calls.every(call => call.executable === f.managed)).toBe(true);
});
it("pins the managed executable for Terminal even when the login shell changes PATH", async () => {
  const f = await fixture();
  await promisify(execFile)("/bin/sh", ["-c", claudeNativeTerminalCommand(f.home)], { env: { HOME: f.home, PATH: "/usr/bin:/bin" }, timeout: 3000 });
  const calls = (await readFile(join(f.home, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toEqual([{ executable: f.managed, args: [] }]);
});

it("observes a newly installed managed executable without recreating its status reader", async () => {
  const f = await fixture(); await rm(f.managed);
  const read = createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: f.home, environment: buildAgentRuntimeEnvironment(f.home), usageReader: async () => null });
  expect(await read()).toBeNull();
  await f.install(f.managed, "exact");
  expect((await read())?.accountLabel).toBe("fixture@example.invalid");
});
