import { describe, expect, it, vi } from "vitest";
import type { CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { applyHarnessSettings } from "../../packages/gateway/src/chat/harness-catalog-admission.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { openProviderAgentSetup } from "../../packages/ui/src/agents-providers/provider-settings-controller.js";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";

const action = { id: "hermes_connect", kind: "foreground_terminal" as const, label: "Connect Hermes", command: "server-issued-hermes-command" };
const instance = { id: "hermes_default", driverKind: "hermes", availability: "auth_required", models: [], options: [],
  setupActions: [action], skills: [], commands: [] } as unknown as Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">;
const settings = { harnesses: [{ id: "harness_hermes", harness: "hermes", enabled: false, configuredEnabled: false,
  accessSourceId: null, route: { kind: "configurable", providerId: "anthropic", modelId: "claude-fable-5" } }], accessSources: [] } as unknown as ProviderSettingsSnapshot;
const project = (includeSettingsSetupActions = false) => applyHarnessSettings({ instances: [instance], settings,
  settingsRequired: true, settingsAvailable: true, executableDriverKinds: ["hermes"],
  systemRepairAction: () => action, now: new Date(), includeSettingsSetupActions });

describe("Settings-only setup catalog negotiation", () => {
  it("retains explicit Off and Chat admission while allowing server-issued setup only on explicit Settings negotiation", () => {
    expect(project()[0]).toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings", setupActions: [], models: [] });
    expect(project(true)[0]).toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings", setupActions: [action], models: [] });
    expect(settings.harnesses[0]!.configuredEnabled).toBe(false);
  });
  it.each(["claude_code", "codex", "opencode", "pi", "hermes", "openclaw"] as const)(
    "keeps %s Off while allowing its original server setup command in Settings", driverKind => {
      const harness = driverKind === "claude_code" ? "claude" : driverKind;
      const original = { ...instance, driverKind, id: `${driverKind}_default`, availability: "available" as const,
        setupActions: [{ ...action, id: `${harness}_connect` }] };
      const ownerSettings = { ...settings, harnesses: [{ ...settings.harnesses[0]!, harness,
        enablementOrigin: "owner_configuration" as const }] };
      const base = { instances: [original], settings: ownerSettings, settingsRequired: true, settingsAvailable: true,
        executableDriverKinds: [driverKind], systemRepairAction: () => action, now: new Date() };
      const ordinary = applyHarnessSettings(base)[0]!;
      const negotiated = applyHarnessSettings({ ...base, includeSettingsSetupActions: true })[0]!;
      expect(negotiated).toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings",
        models: [], setupActions: original.setupActions });
      expect(ordinary.availability).toBe("unavailable");
      expect(ordinary.models).toEqual([]);
      expect(applyHarnessSettings(base)[0]).toEqual(ordinary);
      const unavailable = applyHarnessSettings({ ...base, executableDriverKinds: [], includeSettingsSetupActions: true })[0]!;
      expect(unavailable.availability).toBe("unavailable");
      expect(unavailable.models).toEqual([]);
      expect(unavailable.setupActions).toEqual([]);
    },
  );
  it("does not restore setup for missing executable admission or unavailable owner settings", () => {
    for (const patch of [{ executableDriverKinds: [] }, { settingsAvailable: false }]) {
      const projected = applyHarnessSettings({ instances: [instance], settings, settingsRequired: true,
        settingsAvailable: true, executableDriverKinds: ["hermes"], systemRepairAction: () => action,
        now: new Date(), includeSettingsSetupActions: true, ...patch });
      expect(projected[0]!.availability).toBe("unavailable");
      expect(projected[0]!.models).toEqual([]);
      const ordinary = applyHarnessSettings({ instances: [instance], settings, settingsRequired: true,
        settingsAvailable: true, executableDriverKinds: ["hermes"], systemRepairAction: () => action,
        now: new Date(), ...patch });
      expect(projected).toEqual(ordinary);
    }
  });
  it("opens the real server-issued Hermes setup through the authenticated route while keeping saved Off", async () => {
    const runtimeSource = async () => ({ runtime: { selected: "hermes" as const, transition: null,
      options: [{ id: "hermes" as const, displayName: "Hermes", installState: "installed" as const,
        health: "healthy" as const, selectionState: "active" as const, configured: false,
        capabilities: ["provider_catalog" as const, "authentication" as const] }] },
      providers: [], messaging: { runtime: "hermes" as const, provider: null, model: null, configured: false } });
    const catalog = createChatProviderCatalogService({ codingProviders: { listProviders: async () => [], invalidate: () => undefined },
      agentRuntimeSource: runtimeSource, harnessSettingsSource: { getSnapshot: async () => settings },
      executableDriverKinds: ["hermes"] });
    const app = createChatProviderRoutes({ catalog, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
    const openCommand = vi.fn(async () => true);
    const getCatalog = async (flag: string) => {
      const response = await app.request(`/api/chat-providers?refresh=true${flag}`);
      expect(response.status).toBe(200);
      return await response.json();
    };
    expect(await openProviderAgentSetup({ harness: "hermes", openCommand,
      getCatalog: () => getCatalog("") })).toBe(false);
    expect(openCommand).not.toHaveBeenCalled();
    expect(await openProviderAgentSetup({ harness: "hermes", openCommand,
      getCatalog: () => getCatalog("&includeSettingsSetupActions=true") })).toBe(true);
    expect(openCommand).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("hermes"));
    const ordinary = await catalog.getCatalog({ userId: "owner", source: "jwt" });
    expect(ordinary.instances.find(candidate => candidate.id === "hermes_default")).toMatchObject({
      availability: "unavailable", unavailabilityReason: "disabled_in_settings", models: [], setupActions: [],
    });
    expect(settings.harnesses[0]!.configuredEnabled).toBe(false);
  });
  it("passes negotiated setup intent through refresh and rejects invalid or repeated query flags", async () => {
    const refresh = vi.fn(async () => ({ revision: "test", drivers: [], instances: [] }) as CanonicalProviderCatalog);
    const getCatalog = vi.fn(refresh);
    const app = createChatProviderRoutes({ catalog: { refresh, getCatalog }, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
    expect((await app.request("/api/chat-providers?refresh=true&includeSettingsSetupActions=true")).status).toBe(200);
    expect(refresh).toHaveBeenCalledWith({ userId: "owner", source: "jwt" }, { includeSettingsSetupActions: true });
    for (const query of ["includeSettingsSetupActions=wrong", "includeSettingsSetupActions=true&includeSettingsSetupActions=false"]) {
      expect((await app.request(`/api/chat-providers?${query}`)).status).toBe(400);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
