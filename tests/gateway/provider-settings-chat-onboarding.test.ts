import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import type { ProviderLoginCoordinator } from "../../packages/gateway/src/ai-providers/provider-settings-coordinators.js";
import { deriveChatProviderConnectionState } from "../../packages/ui/src/agents-providers/ChatProviderConnections";

const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function freshRuntime() {
  const homePath = await mkdtemp(join(tmpdir(), "chat-onboarding-first-run-")); homes.push(homePath);
  const now = new Date();
  vi.spyOn(Date, "now").mockReturnValue(+now);
  const producer = new AiProviderService({ homePath, env: {}, now: () => now,
    driverInventory: async () => ["hermes", "claude_code", "codex", "opencode", "pi"].map((id) => ({
      id, displayName: id, kind: "cli", installState: "installed", health: id === "hermes" ? "degraded" : "unknown", capabilities: ["tools"], setupActions: [],
    })),
    codexLocalObservation: async () => ({ accessSourceId: "owner_openai_profile", state: "absent", checkedAt: now.toISOString(), staleAfter: new Date(+now + 5_000).toISOString() }),
  });
  const canonical = await producer.getSnapshot(); producer.close();
  // Exact fresh-VPS shape: catalog-only OpenCode free models, no configured
  // native default, and failed optional Pi discovery. Neither is a login.
  canonical.nativeHarnessCatalog = { profiles: [{ harness: "opencode", providerId: "opencode", providerDisplayName: "OpenCode", models: [{ id: "opencode:free", displayName: "Free model", enabled: true }],
    defaultModelId: null, localObservation: { state: "unknown", checkedAt: now.toISOString(), staleAfter: new Date(+now + 5_000).toISOString() } }], failures: ["pi"] };
  const startLogin = vi.fn(async ({ mutation, harness }: Parameters<ProviderLoginCoordinator["startLogin"]>[0]) => ({
    id: "fresh-runtime-attempt", harnessInstanceId: harness.id, accountId: mutation.accountId, method: mutation.method, state: "pending" as const,
    expiresAt: new Date(+now + 60_000).toISOString(), action: { kind: "open_terminal" as const, terminalSessionId: "fresh-claude-login" }, safeFailure: null,
  }));
  const privateRootPath = `${homePath}-private`; homes.push(privateRootPath);
  const store = new ProviderSettingsStore({ homePath, privateRootPath, now: () => now, providerSnapshotReader: { getSnapshot: async () => canonical },
    loginCoordinator: { supportedMethods: (harness) => ["claude", "codex"].includes(harness.harness) ? ["terminal"] : [], startLogin } });
  const app = new Hono(); app.route("/api/ai", createProviderSettingsRoutes({ store, getPrincipal: () => ({ userId: "fixture-owner" }) }));
  const snapshot = async () => {
    const response = await app.request("/api/ai/provider-settings?includeCapabilities=true&refresh=true");
    expect(response.status).toBe(200);
    return ProviderSettingsSnapshotSchema.parse(await response.json());
  };
  return { now, canonical, snapshot, app, startLogin };
}

describe("fresh-runtime Chat connection evidence", () => {
  it.each([true, false])("collects Codex absence after slow optional native discovery on refresh=%s", async (refresh) => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-onboarding-observation-order-")); homes.push(homePath);
    let time = +new Date();
    const observation = vi.fn(async () => ({ accessSourceId: "owner_openai_profile", state: "absent" as const,
      checkedAt: new Date(time).toISOString(), staleAfter: new Date(time + 5_000).toISOString() }));
    const producer = new AiProviderService({ homePath, env: {}, now: () => new Date(time), codexLocalObservation: observation,
      nativeHarnessCatalogReader: { getCatalog: async () => { time += 6_500; return { providers: [], accessSources: [], failures: ["pi"] }; } },
    });
    try {
      const canonical = await producer.getSnapshot({ refresh });
      const local = canonical.accessSources.find((source) => source.id === "owner_openai_profile")?.localObservation;
      expect(local).toEqual({ state: "absent", checkedAt: new Date(time).toISOString(), staleAfter: new Date(time + 5_000).toISOString() });
      expect(observation).toHaveBeenCalledOnce();
    } finally { producer.close(); }
  });
  it("preserves canonical missing credentials through Settings despite optional catalog failure", async () => {
    const { canonical, snapshot } = await freshRuntime();
    expect(canonical.accessSources.find((source) => source.id === "owner_anthropic_profile")?.state).toBe("setup_required");
    const result = await snapshot();
    expect(result.harnesses.map((harness) => harness.harness).sort()).toEqual(["claude", "codex", "hermes", "opencode", "pi"]);
    expect(result.accessSources.find((source) => source.id === "owner_anthropic_profile")).toBeUndefined();
    expect(result.harnesses.filter((harness) => harness.harness !== "codex").every((harness) => harness.authState === "unauthenticated")).toBe(true);
    expect(result.harnesses.find((harness) => harness.harness === "pi")?.enabled).toBe(false);
    expect(result.harnesses.find((harness) => harness.harness === "pi")?.routeAvailability).toBe("catalog_unavailable");
    expect(result.harnesses.find((harness) => harness.harness === "codex")?.authState).toBe("unknown");
    expect(deriveChatProviderConnectionState(result)).toBe("disconnected");
  });
  it.each(["present_unverified", "unknown", "expired"])("retains normal Chat for %s Codex observation", async (state) => {
    const { canonical, now, snapshot } = await freshRuntime();
    canonical.accessSources.find((source) => source.id === "owner_openai_profile")!.localObservation = {
      state: state === "expired" ? "absent" : state as "unknown" | "present_unverified", checkedAt: now.toISOString(), staleAfter: new Date(+now + (state === "expired" ? -1 : 5_000)).toISOString(),
    };
    expect(deriveChatProviderConnectionState(await snapshot())).toBe("unknown");
  });
  it.each(["expired", "future", "missing_timestamps", "fresh"])("preserves freshness for %s absence on an omitted owner source", async (state) => {
    const { canonical, now, snapshot } = await freshRuntime();
    canonical.accessSources.find((source) => source.id === "owner_anthropic_profile")!.localObservation = {
      state: "absent", checkedAt: state === "missing_timestamps" ? null : new Date(+now + (state === "future" ? 1_000 : -5_000)).toISOString(),
      staleAfter: state === "missing_timestamps" ? null : new Date(+now + (state === "expired" ? -1 : 5_000)).toISOString(),
    };
    const result = await snapshot();
    expect(result.harnesses.find((harness) => harness.harness === "claude")?.authState).toBe(state === "fresh" ? "unauthenticated" : "unknown");
    expect(deriveChatProviderConnectionState(result)).toBe(state === "fresh" ? "disconnected" : "unknown");
  });
  it.each(["expired", "future", "missing_timestamps", "fresh"])("preserves freshness for %s absence on native driver evidence", async (state) => {
    const { canonical, now, snapshot } = await freshRuntime();
    canonical.drivers.find((driver) => driver.id === "hermes")!.nativeRouteObservation = {
      providerId: "anthropic", modelId: "claude-opus-4-6", credentialKind: "provider_profile",
      localObservation: { state: "absent", checkedAt: state === "missing_timestamps" ? null : new Date(+now + (state === "future" ? 1_000 : -5_000)).toISOString(),
        staleAfter: state === "missing_timestamps" ? null : new Date(+now + (state === "expired" ? -1 : 5_000)).toISOString() },
    };
    const result = await snapshot();
    expect(result.harnesses.find((harness) => harness.harness === "hermes")?.authState).toBe(state === "fresh" ? "unauthenticated" : "unknown");
    expect(deriveChatProviderConnectionState(result)).toBe(state === "fresh" ? "disconnected" : "unknown");
  });
  it.each(["unknown", "unavailable", "ready"] as const)("does not replace %s configured owner credentials with absence", async (state) => {
    const { canonical, snapshot } = await freshRuntime();
    const source = canonical.accessSources.find((source) => source.id === "owner_anthropic_key")!;
    source.state = state; source.action = state === "ready" ? "none" : "retry";
    const result = await snapshot();
    expect(result.harnesses.find((harness) => harness.harness === "hermes")?.authState).toBe("unknown");
    expect(deriveChatProviderConnectionState(result)).toBe("unknown");
  });
  it("retains unverified native profiles even when their discovered route is not selected", async () => {
    const { canonical, snapshot } = await freshRuntime();
    canonical.nativeHarnessCatalog!.profiles[0]!.localObservation.state = "present_unverified";
    expect(deriveChatProviderConnectionState(await snapshot())).toBe("unknown");
  });
  it("retains normal Chat for a configured but unverified native route", async () => {
    const { canonical, snapshot } = await freshRuntime();
    canonical.nativeHarnessCatalog!.profiles[0]!.defaultModelId = "opencode:free";
    expect(deriveChatProviderConnectionState(await snapshot())).toBe("unknown");
  });
  it("suppresses onboarding for an authenticated owner account", async () => {
    const { canonical, now, snapshot } = await freshRuntime();
    Object.assign(canonical.accounts.find((account) => account.id === "owner_anthropic")!, { authMethod: "provider_profile", state: "ready", action: "none", safeReason: null, checkedAt: now.toISOString() });
    Object.assign(canonical.accessSources.find((source) => source.id === "owner_anthropic_profile")!, { state: "ready", action: "none", safeReason: null, checkedAt: now.toISOString() });
    expect(deriveChatProviderConnectionState(await snapshot())).toBe("connected");
  });
  it("starts the supported server-issued login when no account or credential source is projected", async () => {
    const { snapshot, app, startLogin } = await freshRuntime();
    const initial = await snapshot();
    const claude = initial.harnesses.find((harness) => harness.harness === "claude")!;
    expect(claude.selectedAccountId).toBeNull(); expect(claude.accessSourceId).toBeNull();
    expect(claude.recommendedLoginMethod).toBe("terminal");
    const response = await app.request("/api/ai/provider-settings/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      type: "start_login", harnessInstanceId: claude.id, accountId: null, method: "terminal", expectedRevision: initial.revision, idempotencyKey: "first-run-login",
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "login_attempt", attempt: { accountId: null, harnessInstanceId: claude.id, state: "pending", action: { kind: "open_terminal", terminalSessionId: "fresh-claude-login" } } });
    expect(startLogin).toHaveBeenCalledOnce();
  });
});
