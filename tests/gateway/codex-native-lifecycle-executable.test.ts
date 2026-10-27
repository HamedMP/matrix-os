import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { normalizeCodexNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";
import { resolveCodexNativeExecutable } from "../../packages/gateway/src/ai-providers/codex-native-terminal-command.js";

vi.mock("../../packages/gateway/src/ai-providers/codex-native-terminal-command.js", () => ({ resolveCodexNativeExecutable: vi.fn(() => "/other/bin/codex") }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function metadata(email: string) {
  const value = normalizeCodexNativeAccountMetadata({ account: { type: "chatgpt", email } }, {}, new Date())!;
  return bindNativeAccountMetadata(value, async () => true, email);
}

it("logs out with the same pinned Codex executable used by runtime observation", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "codex-pinned-logout-")); roots.push(homePath);
  const current = metadata("owner@example.invalid");
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const guard = { run: async (_profile: unknown, _admission: unknown, operation: () => Promise<unknown>) => operation() };
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["codex"],
    profileGuard: guard as never, codexExecutable: "/pinned/bin/codex", run,
    readCodexAccountUnderLease: async () => current });
  await lifecycle.logout({ account: { id: "owner_codex", providerId: "openai", driverId: "codex", harness: "codex",
    accessSourceId: "owner_openai_profile", authMethod: "terminal", installState: "installed", authenticated: true,
    driverAccountCount: 1, nativeCodexAccount: current }, idempotencyKey: "pinned-logout" });
  expect(run).toHaveBeenCalledWith("/pinned/bin/codex", ["logout"], expect.objectContaining({ cwd: homePath }));
  expect(resolveCodexNativeExecutable).not.toHaveBeenCalled();
});

it("records safe proof phase when the CLI principal changes before logout", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "codex-drift-logout-")); roots.push(homePath);
  const previous = metadata("old@example.invalid");
  const replacement = metadata("new@example.invalid");
  const run = vi.fn();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const guard = { run: async (_profile: unknown, _admission: unknown, operation: () => Promise<unknown>) => operation() };
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["codex"],
    profileGuard: guard as never, codexExecutable: "/pinned/bin/codex", run,
    readCodexAccountUnderLease: async () => replacement });
  await expect(lifecycle.logout({ account: { id: "owner_codex", providerId: "openai", driverId: "codex", harness: "codex",
    accessSourceId: "owner_openai_profile", authMethod: "terminal", installState: "installed", authenticated: true,
    driverAccountCount: 1, nativeCodexAccount: previous }, idempotencyKey: "drift-logout" })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith("[provider-lifecycle] Native Codex sign-out proof unavailable:",
    { phase: "under_lease", reason: "principal_changed", profile: "codex" });
  expect(JSON.stringify(warning.mock.calls)).not.toMatch(/old@example|new@example|\/pinned\/bin/);
});
