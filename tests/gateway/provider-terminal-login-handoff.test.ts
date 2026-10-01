import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsMutationResponseSchema, type TerminalRef, type TerminalTab, type ProviderSettingsMutationResponse } from "@matrix-os/contracts";
import type { ProviderSettingsStoreWriter } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { createProviderTerminalLoginCoordinator } from "../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js";
import { createProviderTerminalLoginHandoff as handoff } from "../../packages/gateway/src/ai-providers/provider-terminal-login-handoff.js";
import { createProviderLoginTerminalRegistry } from "../../packages/gateway/src/session-runtime-bridge.js";
import { parseTerminalRefKey } from "../../shell/src/components/terminal/terminal-session-id.js";
import { parseTerminalRefKey as parseElectronTerminalRefKey } from "../../desktop/src/renderer/src/lib/terminal-workspaces.js";
import { PROVIDER_SETTINGS_NOW as NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture.js";

const REF = { workspaceId: "tws_00000000000000000000000000000001", tabId: "tt_00000000000000000000000000000001" };
const KEY = `${REF.workspaceId}:${REF.tabId}`;
const mutation = { type: "start_login" as const, expectedRevision: 0,
  idempotencyKey: "login_handoff", harnessInstanceId: "harness_claude_code", accountId: null, method: "terminal" as const };
const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mutation) };

function appFor(store: ProviderSettingsStoreWriter, principal: unknown = { userId: "owner" }) {
  const app = new Hono();
  app.route("/api/ai", createProviderSettingsRoutes({ store, getPrincipal: () => principal }));
  return app;
}

function cachedResult(action = { kind: "open_terminal" as const, terminalSessionId: "provider-auth-existing" }) {
  return { kind: "login_attempt" as const, snapshot: disconnectedSnapshot(), attempt: {
    id: "attempt_existing", harnessInstanceId: mutation.harnessInstanceId, accountId: null, method: "terminal" as const,
    state: "pending" as const, action, expiresAt: "2026-08-30T10:10:00.000Z", safeFailure: null,
  } };
}

describe("provider Terminal login handoff", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "provider-login-handoff-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("projects fresh and persisted replay attempts to the same Electron-compatible tab without changing receipts", async () => {
    const tabs: TerminalTab[] = [];
    const workspace = { id: REF.workspaceId, scope: "main" as const, canonicalSize: { cols: 120, rows: 36 },
      status: "running" as const, revision: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), tabs };
    const runtime = { listWorkspaces: vi.fn(async () => [workspace]), ensureWorkspace: vi.fn(async () => workspace),
      createTab: vi.fn(async (_id: string, input: Parameters<Parameters<typeof createProviderLoginTerminalRegistry>[0]["createTab"]>[1]) => {
        const tab: TerminalTab = { id: `tt_${String(tabs.length + 1).padStart(32, "0")}`, workspaceId: REF.workspaceId, name: input.name ?? "Terminal", cwd: "", status: "running",
          revision: 1, incarnation: `ti_${String(tabs.length + 1).padStart(32, "0")}`, order: 0, agent: input.agent, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
        tabs.push(tab); return tab;
      }), renameTab: vi.fn(async (ref: TerminalRef, input: { name: string }) => {
        const tab = tabs.find(t => t.id === ref.tabId)!;
        tab.name = input.name; tab.revision += 1; return tab;
      }), archiveEndedTab: vi.fn(async (ref: TerminalRef, input: { name: string }) => {
        const tab = tabs.find(t => t.id === ref.tabId)!;
        tab.name = input.name; tab.revision += 1; return tab;
      }), terminateTab: vi.fn(), getCommandState: vi.fn(async () => "running" as "running" | "exited" | "unknown") };
    const registry = createProviderLoginTerminalRegistry(runtime);
    const login = createProviderTerminalLoginCoordinator({ homePath: join(root, "home"), registry,
      enabledHarnesses: ["claude"], now: () => NOW });
    const start = vi.spyOn(login, "startLogin");
    const createStore = () => new ProviderSettingsStore({ homePath: join(root, "home"), privateRootPath: join(root, "private"),
      providerSnapshotReader: { getSnapshot: async () => providerSettingsCanonicalFixture() }, loginCoordinator: login, now: () => NOW });
    const store = createStore();
    const app = appFor(handoff(store, (id) => registry.resolveTerminalRef(id), login.resolveTerminalIdentity));
    const first = await app.request("/api/ai/provider-settings/actions?includeCapabilities=true", request);
    expect(first.status).toBe(200);
    const initial = await first.json();
    expect(initial.attempt.action.terminalSessionId).toBe(KEY);
    expect(parseTerminalRefKey(initial.attempt.action.terminalSessionId)).toEqual(REF);
    expect(parseElectronTerminalRefKey(initial.attempt.action.terminalSessionId)).toEqual(REF);
    expect(ProviderSettingsMutationResponseSchema.safeParse(initial).success).toBe(true);
    const replay = await appFor(handoff(createStore(), (id) => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions?includeCapabilities=true", request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(initial);
    expect(start).toHaveBeenCalledOnce();
    expect(runtime.createTab).toHaveBeenCalledOnce();
    const recoveryStore = createStore();
    const revision = (await recoveryStore.getSnapshot()).revision;
    const recovered = await appFor(handoff(recoveryStore, (id) => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", { ...request,
        body: JSON.stringify({ ...mutation, expectedRevision: revision, idempotencyKey: "login_handoff_recovery" }) });
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).attempt.action.terminalSessionId).toBe(KEY);
    expect(runtime.createTab).toHaveBeenCalledOnce();
    const receipt = await readFile(join(root, "home/system/ai-providers/login-receipts.json"), "utf8");
    expect(receipt).toContain(tabs[0].name);
    expect(receipt).not.toContain(KEY);
    const raw = await store.mutate(mutation);
    expect(raw.kind === "login_attempt" && raw.attempt.action).toEqual({ kind: "open_terminal", terminalSessionId: tabs[0].name });

    const originalName = tabs[0].name;
    const resolveRef = registry.resolveTerminalRef;
    let releaseResolution!: () => void;
    let resolutionEntered!: () => void;
    const resolutionGate = new Promise<void>(resolve => { releaseResolution = resolve; });
    const entered = new Promise<void>(resolve => { resolutionEntered = resolve; });
    vi.spyOn(registry, "resolveTerminalRef").mockImplementationOnce(async identity => {
      resolutionEntered(); await resolutionGate; return resolveRef(identity);
    });
    const inFlightReplay = appFor(handoff(createStore(), id => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", request);
    await entered;
    runtime.getCommandState.mockResolvedValueOnce("exited");
    const endedStore = createStore();
    const endedRevision = (await endedStore.getSnapshot()).revision;
    const replacement = appFor(handoff(endedStore, id => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", { ...request,
        body: JSON.stringify({ ...mutation, expectedRevision: endedRevision, idempotencyKey: "login_handoff_exited" }) });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runtime.createTab).toHaveBeenCalledOnce();
    releaseResolution();
    const inFlightResult = await inFlightReplay;
    expect((await inFlightResult.json()).attempt).toEqual(initial.attempt);
    const restarted = await replacement;
    expect(restarted.status).toBe(200);
    expect((await restarted.json()).attempt.action.terminalSessionId).toBe(`${REF.workspaceId}:${tabs[1].id}`);
    expect(tabs[0].name).toMatch(/^provider-auth-ended-/);
    expect(tabs[1].name).toBe(originalName);
    expect(runtime.createTab).toHaveBeenCalledTimes(2);
    expect(runtime.terminateTab).not.toHaveBeenCalled();
    const oldReplay = await appFor(handoff(createStore(), id => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", request);
    expect(oldReplay.status).toBe(200);
    expect((await oldReplay.json()).attempt).toEqual(initial.attempt);
    expect(runtime.createTab).toHaveBeenCalledTimes(2);

    runtime.getCommandState.mockResolvedValueOnce("exited");
    const thirdStore = createStore();
    const thirdRevision = (await thirdStore.getSnapshot()).revision;
    const third = await appFor(handoff(thirdStore, id => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", { ...request,
        body: JSON.stringify({ ...mutation, expectedRevision: thirdRevision, idempotencyKey: "login_handoff_exited_again" }) });
    expect(third.status).toBe(200);
    expect((await third.json()).attempt.action.terminalSessionId).toBe(`${REF.workspaceId}:${tabs[2].id}`);
    const firstAgain = await appFor(handoff(createStore(), id => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", request);
    expect((await firstAgain.json()).attempt).toEqual(initial.attempt);
    const secondAgain = await appFor(handoff(createStore(), id => registry.resolveTerminalRef(id), login.resolveTerminalIdentity))
      .request("/api/ai/provider-settings/actions", { ...request,
        body: JSON.stringify({ ...mutation, expectedRevision: endedRevision, idempotencyKey: "login_handoff_exited" }) });
    expect((await secondAgain.json()).attempt.action.terminalSessionId).toBe(`${REF.workspaceId}:${tabs[1].id}`);
    expect(runtime.createTab).toHaveBeenCalledTimes(3);
  });

  it("projects a historical cached attempt without invoking login or changing the cached object", async () => {
    const cached = cachedResult();
    const store = { getSnapshot: vi.fn(async () => cached.snapshot), mutate: vi.fn(async () => cached) };
    const resolve = vi.fn(async () => REF);
    const response = await appFor(handoff(store, resolve)).request("/api/ai/provider-settings/actions", request);
    expect(response.status).toBe(200);
    expect((await response.json()).attempt.action).toEqual({ kind: "open_terminal", terminalSessionId: KEY });
    expect(resolve).toHaveBeenCalledWith("provider-auth-existing");
    expect(cached.attempt.action.terminalSessionId).toBe("provider-auth-existing");
    const projectedStore = handoff(store, resolve);
    await expect(projectedStore.getSnapshot({ refresh: true })).resolves.toBe(cached.snapshot);
    expect(store.getSnapshot).toHaveBeenCalledWith({ refresh: true });
  });

  it.each(["missing", "ambiguous", "private /home/account secret", "invalid_ref"])("fails closed with a safe route response for %s", async (reason) => {
    const store = { getSnapshot: vi.fn(), mutate: vi.fn(async () => cachedResult()) };
    const resolve = vi.fn(async () => {
      if (reason === "invalid_ref") return { workspaceId: "legacy", tabId: "bad" };
      throw new Error(reason);
    });
    const response = await appFor(handoff(store, resolve)).request("/api/ai/provider-settings/actions", request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "provider_settings_unavailable", message: "Provider settings are unavailable." } });
  });

  it("authenticates before touching the store or resolving a terminal", async () => {
    const store = { getSnapshot: vi.fn(), mutate: vi.fn(async () => cachedResult()) };
    const resolve = vi.fn(async () => REF);
    const response = await appFor(handoff(store, resolve), null).request("/api/ai/provider-settings/actions", request);
    expect(response.status).toBe(401);
    expect(store.mutate).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves snapshots, browser login and expired/none attempts unchanged", async () => {
    const base = cachedResult();
    const results: ProviderSettingsMutationResponse[] = [
      { kind: "snapshot", snapshot: base.snapshot },
      { ...base, attempt: { ...base.attempt, method: "browser", action: { kind: "open_browser",
        authorizationPath: "/api/ai/providers/login-attempts/attempt_existing/authorize" } } },
      { ...base, attempt: { ...base.attempt, state: "expired", safeFailure: "expired", action: { kind: "none" } } },
    ];
    const resolve = vi.fn(async () => REF);
    for (const result of results) {
      const store = { getSnapshot: vi.fn(), mutate: vi.fn(async () => result) };
      await expect(handoff(store, resolve).mutate(mutation)).resolves.toBe(result);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("checks dependencies at registration", () => {
    const store = { getSnapshot: vi.fn(), mutate: vi.fn() };
    expect(() => handoff(store, undefined as never)).toThrow("resolver is required");
    expect(() => handoff({} as never, vi.fn())).toThrow("store is required");
  });
});
