import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createCodexNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
vi.mock("../../packages/gateway/src/ai-providers/codex-native-terminal-command.js", () => ({ resolveCodexNativeExecutable: () => "/fixture/bin/codex" }));

it.each([false, true])("real API-key file proof enables guarded logout (replacement=%s)", async replace => {
  const root = await mkdtemp(join(tmpdir(), "codex-key-logout-"));
  const homePath = join(root, "home");
  await mkdir(join(homePath, ".codex"), { recursive: true, mode: 0o700 });
  const authPath = join(homePath, ".codex/auth.json");
  const keyDocument = (key: string) => JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key, tokens: null });
  await writeFile(authPath, keyDocument("synthetic-first-key"), { mode: 0o600 });
  let loggedIn = true;
  const spawnProcess = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit("close")); return true; } });
    child.stdin.on("data", chunk => {
      const request = JSON.parse(chunk.toString());
      if (!request.id) return;
      const result = request.method === "initialize" ? {} : request.method === "config/read" ? { config: { cli_auth_credentials_store: "file" } } : { account: loggedIn ? { type: "apiKey" } : null };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
    });
    return child as never;
  };
  const readMetadata = createCodexNativeAccountMetadataReader({ executable: "/fixture/bin/codex", cwd: homePath, environment: { HOME: homePath }, spawnProcess });
  const guard = createNativeProviderProfileGuard({ homePath, registry: { listProfileSessions: async () => [], get: async () => { throw Object.assign(new Error("missing"), { code: "session_not_found" }); }, observeAgentLiveness: async () => "stopped" } });
  const nativeRun = vi.fn(async () => { await rm(authPath); loggedIn = false; return { stdout: "", stderr: "" }; });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["codex"], profileGuard: guard, run: nativeRun, readCodexAccountUnderLease: readMetadata });
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: "codex", displayName: "Codex", kind: "cli", installState: "installed", health: "ready", setupActions: [], capabilities: ["tools"] }] });
  const independent = join(root, "matrix-ai.json");
  await writeFile(independent, JSON.stringify({ grant: "synthetic-independent-grant", enabled: true }));
  try {
    const store = new ProviderSettingsStore({ homePath, privateRootPath: join(root, "private"), providerSnapshotReader: service, accountLifecycle: lifecycle, codexNativeAccountMetadataReader: readMetadata });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.supportedActions).toContain("logout_account");
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-first-key|credentialIdentityBound|credentialProof/);
    const original = guard.run.bind(guard);
    guard.run = async (profile, admission, operation) => {
      if (replace) await writeFile(authPath, keyDocument("synthetic-replacement-key"));
      return original(profile, admission, operation);
    };
    const mutation = { type: "logout_account" as const, accountId: "owner_codex", expectedRevision: snapshot.revision, idempotencyKey: "key-logout" };
    if (replace) {
      await expect(store.mutate(mutation)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
      expect(nativeRun).not.toHaveBeenCalled();
      expect(await readFile(authPath, "utf8")).toBe(keyDocument("synthetic-replacement-key"));
    } else {
      await store.mutate(mutation);
      expect(nativeRun).toHaveBeenCalledOnce();
      expect(nativeRun).toHaveBeenCalledWith("/fixture/bin/codex", ["logout"], expect.objectContaining({ cwd: homePath }));
      expect(await readMetadata()).toBeNull();
    }
    expect(JSON.parse(await readFile(independent, "utf8"))).toEqual({ grant: "synthetic-independent-grant", enabled: true });
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
