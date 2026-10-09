import { mkdtemp, mkdir, readFile, readdir, rename, lstat, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { createProviderTerminalLoginCoordinator } from "../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js";
import { createCodexKeySaver, createProviderKeyVerifier } from "../../packages/gateway/src/ai-providers/provider-workflow-key.js";
import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import type { ProviderSettingsStoreWriter } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { isHomeMirrorIgnored, parseOwnerSyncIgnore } from "../../packages/gateway/src/sync/home-mirror-ignore.js";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-connect-")); roots.push(root);
  const home = join(root, "home"); await mkdir(join(home, "system/ai-providers"), { recursive: true });
  return home;
}

it("fences two terminal login coordinators before an in-flight launch publishes its session", async () => {
  const home = await fixture(); const sessions = new Set<string>(); const gate = Promise.withResolvers<void>();
  const registry = {
    get: async (name: string) => {
      if (!sessions.has(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" });
      return { name, agent: "claude" };
    },
    listProfileSessions: async () => [...sessions].map(name => ({ name, agent: "claude" })),
    create: vi.fn(async ({ name }: { name: string }) => {
      if (registry.create.mock.calls.length === 1) await gate.promise;
      sessions.add(name); return { name };
    }),
    delete: async (name: string) => { sessions.delete(name); },
    rename: async (name: string, next: string) => { sessions.delete(name); sessions.add(next); return { name: next }; },
    observeAgentLiveness: async () => "running" as const,
  };
  const coordinator = () => createProviderTerminalLoginCoordinator({ homePath: home, registry, enabledHarnesses: ["claude"],
    profileGuard: createNativeProviderProfileGuard({ homePath: home, registry }) });
  const input = (id: string) => ({ mutation: { type: "start_login" as const, expectedRevision: 0, idempotencyKey: `login_${id}`,
    harnessInstanceId: id, accountId: null, method: "terminal" as const },
    harness: { id, driverId: "claude_code", harness: "claude" as const, providerId: "anthropic", modelId: "claude-sonnet-5", installState: "installed" as const } });
  const first = coordinator().startLogin(input("harness_claude_code"));
  try {
    await vi.waitFor(() => expect(registry.create).toHaveBeenCalledOnce());
    await expect(coordinator().startLogin(input("harness_claude_code_second"))).rejects.toThrow("lifecycle_unavailable");
    expect(registry.create).toHaveBeenCalledOnce();
  } finally { gate.resolve(); await first; }
});

it.each(["snapshot", "revision"] as const)("preserves previous native auth bytes when key Connect fails during %s", async failure => {
  const home = await fixture(); const prefix = join(home, "runtime");
  await mkdir(join(home, ".codex")); await mkdir(join(prefix, "bin"), { recursive: true });
  const auth = join(home, ".codex/auth.json"), original = '{"old":"keep-exact"}\n';
  await writeFile(auth, original, { mode: 0o600 });
  await writeFile(join(prefix, "bin/codex"), '#!/bin/sh\nread -r key\nprintf \'{"OPENAI_API_KEY":"%s","tokens":null}\\n\' "$key" > "$CODEX_HOME/auth.json"\n', { mode: 0o700 });
  const snapshot = { revision: 3, access: { mode: "writable" }, harnessCatalog: [], harnesses: [{ id: "harness_codex", harness: "codex",
    displayName: "Codex", installState: "installed", authState: "unknown", loginMethods: ["terminal"], selectedAccountId: null, enabled: false }] };
  const store = { getSnapshot: vi.fn(async (options?: { refresh?: boolean }) => {
    if (options?.refresh && failure === "snapshot") throw new Error("synthetic snapshot unavailable");
    return snapshot;
  }), mutate: vi.fn(async () => { throw new Error("synthetic revision conflict"); }) } as unknown as ProviderSettingsStoreWriter;
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), observeAgentLiveness: vi.fn() } });
  const verify = createProviderKeyVerifier({ providerId: "openai", profile: "codex", profileGuard: guard,
    fetchFn: async () => new Response("{}"), save: createCodexKeySaver({ homePath: home, runtimePrefix: prefix }) });
  const [adapter] = await createNativeProviderWorkflowAdapters({ store, terminal: {} as TerminalRuntimeSocketClient,
    runtimePrefix: prefix, hostControl: { available: false, run: vi.fn() }, verifyKeys: { codex: verify } });
  await expect(adapter!.verifyKey!({ harnessInstanceId: "harness_codex", providerId: "openai", apiKey: "sk-synthetic-new" })).rejects.toThrow();
  expect(await readFile(auth, "utf8")).toBe(original);
  expect(store.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  if (failure === "revision") expect(store.mutate).toHaveBeenCalledOnce();
  await expect(createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), observeAgentLiveness: vi.fn() } })
    .run("codex", { kind: "write" }, async () => "released")).resolves.toBe("released");
});

function loginInput() {
  return { mutation: { type: "start_login" as const, expectedRevision: 0, idempotencyKey: "login_drain",
    harnessInstanceId: "harness_claude_code", accountId: null, method: "terminal" as const },
    harness: { id: "harness_claude_code", driverId: "claude_code", harness: "claude" as const, providerId: "anthropic", modelId: "claude-sonnet-5", installState: "installed" as const } };
}
it.each(["validation", "deleted-running", "deleted-unknown", "deleted-stopped", "stopped", "running", "unknown", "lost-rpc"] as const)("releases login handoff only with proven drain: %s", async outcome => {
  const home = await fixture(); const sessions = new Set<string>();
  const registry = {
    get: async (name: string) => { if (!sessions.has(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" }); return { name, agent: "claude" }; },
    create: vi.fn(async ({ name }: { name: string }) => { if (outcome === "lost-rpc") throw new Error("lost reply"); sessions.add(name); return { name }; }),
    delete: vi.fn(async (name: string) => { if (!outcome.startsWith("deleted-")) throw new Error("delete unavailable"); sessions.delete(name); }),
    rename: async (_name: string, next: string) => ({ name: next }),
    // Even a stopped/absent observation cannot prove a lost launch RPC never ran.
    observeAgentLiveness: vi.fn(async () => outcome === "stopped" || outcome === "deleted-stopped" || outcome === "lost-rpc" ? "stopped" as const : outcome === "unknown" || outcome === "deleted-unknown" ? "unknown" as const : "running" as const),
  };
  const guard = () => createNativeProviderProfileGuard({ homePath: home, registry });
  const login = createProviderTerminalLoginCoordinator({ homePath: home, registry, enabledHarnesses: ["claude"], profileGuard: guard(),
    persistReceipt: async () => { throw new Error("receipt unavailable"); } });
  const input = loginInput(); if (outcome === "validation") input.harness.driverId = "uninstalled";
  await expect(login.startLogin(input)).rejects.toThrow();
  const probe = guard().run("claude", { kind: "write" }, async () => "available");
  if (["validation", "deleted-stopped", "stopped"].includes(outcome)) await expect(probe).resolves.toBe("available");
  else await expect(probe).rejects.toThrow("lifecycle_unavailable");
  expect(registry.create).toHaveBeenCalledTimes(outcome === "validation" ? 0 : 1);
  if (outcome.startsWith("deleted-")) expect(registry.observeAgentLiveness).toHaveBeenCalled();
});
it("releases temporary handoff after exact cross-coordinator live replay without launching again", async () => {
  const home = await fixture(); const sessions = new Set<string>();
  const registry = {
    get: async (name: string) => { if (!sessions.has(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" }); return { name, agent: "claude" }; },
    create: vi.fn(async ({ name }: { name: string }) => { sessions.add(name); return { name }; }),
    delete: async () => {}, rename: async (_name: string, name: string) => ({ name }),
    observeAgentLiveness: async () => "running" as const,
  };
  const coordinator = () => createProviderTerminalLoginCoordinator({ homePath: home, registry, enabledHarnesses: ["claude"],
    profileGuard: createNativeProviderProfileGuard({ homePath: home, registry }) });
  const first = await coordinator().startLogin(loginInput()); expect(await coordinator().startLogin(loginInput())).toEqual(first);
  expect(registry.create).toHaveBeenCalledOnce();
});

it.each(["success", "unsafe-rollback"] as const)("holds key admission through Settings commit and retains recovery only if needed: %s", async outcome => {
  const home = await fixture(), prefix = join(home, "runtime");
  await mkdir(join(home, ".codex"), { mode: 0o700 }); await mkdir(join(prefix, "bin"), { recursive: true });
  const auth = join(home, ".codex/auth.json"); await writeFile(auth, "previous", { mode: 0o600 });
  await writeFile(join(prefix, "bin/codex"), '#!/bin/sh\nread -r key\nprintf \'{"OPENAI_API_KEY":"%s","tokens":null}\\n\' "$key" > "$CODEX_HOME/auth.json"\n', { mode: 0o700 });
  const registry = { get: vi.fn(), observeAgentLiveness: vi.fn() };
  const guard = () => createNativeProviderProfileGuard({ homePath: home, registry });
  const verify = createProviderKeyVerifier({ providerId: "openai", profile: "codex", profileGuard: guard(), fetchFn: async () => new Response("{}"),
    save: createCodexKeySaver({ homePath: home, runtimePrefix: prefix }) });
  const commit = vi.fn(async () => {
    expect((await readFile(auth, "utf8"))).toContain("sk-synthetic");
    await expect(guard().run("codex", { kind: "write" }, async () => "should-not-run")).rejects.toThrow("lifecycle_unavailable");
    if (outcome === "unsafe-rollback") {
      const foreign = join(home, ".codex/foreign"); await writeFile(foreign, "foreign", { mode: 0o600 }); await rename(foreign, auth);
      throw new Error("synthetic CAS rejection");
    }
  });
  const connecting = verify.connect!({ harnessInstanceId: "harness_codex", providerId: "openai", apiKey: "sk-synthetic" }, commit);
  if (outcome === "success") await connecting; else await expect(connecting).rejects.toThrow("unavailable");
  expect(commit).toHaveBeenCalledOnce();
  const retained = (await readdir(join(home, ".codex"))).filter(name => name.startsWith(".matrix-key-"));
  if (outcome === "success") {
    expect(retained).toEqual([]); await expect(guard().run("codex", { kind: "write" }, async () => "released")).resolves.toBe("released");
  } else {
    expect(retained).toHaveLength(1); const recovery = join(home, ".codex", retained[0]!);
    expect(isHomeMirrorIgnored(`.codex/${retained[0]!}/previous-auth`, undefined, parseOwnerSyncIgnore("!**"))).toBe(true);
    expect((await lstat(recovery)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(recovery, "previous-auth"), "utf8")).toBe("previous");
    expect((await lstat(join(recovery, "previous-auth"))).mode & 0o777).toBe(0o600);
    expect(await readFile(auth, "utf8")).toBe("foreign");
    await expect(guard().run("codex", { kind: "write" }, async () => "should-not-run")).rejects.toThrow("lifecycle_unavailable");
  }
});

it("rechecks native session visibility after acquiring a lease from a stale idle preflight", async () => {
  const home = await fixture(), sessions = new Set<string>();
  const idleObserved = Promise.withResolvers<void>(), resumePreflight = Promise.withResolvers<void>();
  const registry = {
    get: async (name: string) => { if (!sessions.has(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" }); return { name, agent: "claude" }; },
    listProfileSessions: async () => [...sessions].map(name => ({ name, agent: "claude" })),
    create: async ({ name }: { name: string }) => { sessions.add(name); return { name }; },
    delete: async () => {}, rename: async (_name: string, name: string) => ({ name }), observeAgentLiveness: async () => "running" as const,
  };
  const staleRegistry = { ...registry, listProfileSessions: async () => {
    const idle = await registry.listProfileSessions(); idleObserved.resolve(); await resumePreflight.promise; return idle;
  } };
  const writer = vi.fn(async () => "must-not-run");
  const stale = createNativeProviderProfileGuard({ homePath: home, registry: staleRegistry }).run("claude", { kind: "write" }, writer);
  const refused = expect(stale).rejects.toThrow("lifecycle_unavailable");
  await idleObserved.promise;
  const coordinator = createProviderTerminalLoginCoordinator({ homePath: home, registry, enabledHarnesses: ["claude"],
    profileGuard: createNativeProviderProfileGuard({ homePath: home, registry }) });
  await coordinator.startLogin(loginInput()); resumePreflight.resolve(); await refused; expect(writer).not.toHaveBeenCalled();
});

it.each(["unsafe-prior", "symlink-prior", "malformed-staged", "drained-cli-failure"] as const)("releases admission after proven prepublication rejection: %s", async outcome => {
  const home = await fixture(), prefix = join(home, "runtime");
  await mkdir(join(home, ".codex"), { mode: 0o700 }); await mkdir(join(prefix, "bin"), { recursive: true });
  const auth = join(home, ".codex/auth.json"); await writeFile(auth, "previous", { mode: outcome === "unsafe-prior" ? 0o644 : 0o600 });
  if (outcome === "symlink-prior") { await rename(auth, join(home, ".codex/previous")); await symlink("previous", auth); }
  const command = outcome === "drained-cli-failure" ? "exit 1" : outcome === "malformed-staged" ? 'printf \'broken\' > "$CODEX_HOME/auth.json"'
    : 'printf \'{"OPENAI_API_KEY":"%s","tokens":null}\\n\' "$key" > "$CODEX_HOME/auth.json"';
  await writeFile(join(prefix, "bin/codex"), `#!/bin/sh\nread -r key\n${command}\n`, { mode: 0o700 });
  const registry = { get: vi.fn(), observeAgentLiveness: vi.fn() };
  const guard = () => createNativeProviderProfileGuard({ homePath: home, registry });
  const verify = createProviderKeyVerifier({ providerId: "openai", profile: "codex", profileGuard: guard(), fetchFn: async () => new Response("{}"),
    save: createCodexKeySaver({ homePath: home, runtimePrefix: prefix }) });
  const commit = vi.fn();
  await expect(verify.connect!({ harnessInstanceId: "harness_codex", providerId: "openai", apiKey: "sk-synthetic" }, commit)).rejects.toThrow("unavailable");
  expect(commit).not.toHaveBeenCalled(); expect(await readFile(auth, "utf8")).toBe("previous");
  expect((await readdir(join(home, ".codex"))).filter(name => name.startsWith(".matrix-key-"))).toEqual([]);
  await expect(guard().run("codex", { kind: "write" }, async () => "released")).resolves.toBe("released");
});
