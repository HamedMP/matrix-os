import { describe, expect, it } from "vitest";
import type {
  AgentThreadComposerDraft,
  CanonicalProviderCatalog,
  RuntimeSummary,
} from "@matrix-os/contracts";
import {
  applyCanonicalSelectionToAgentDraft,
  createLegacyGlobalProviderCatalog,
  createLegacyProjectProviderCatalog,
  filterCatalogForLegacyGlobal,
  filterCatalogForLegacyProject,
  instanceIdForLegacyProvider,
  legacyGlobalSelectionExecutable,
  legacyProjectSelectionExecutable,
  permissionModeForAgentDraft,
} from "../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import { createCanonicalComposerSelection } from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";

const NOW = "2026-08-25T00:00:00.000Z";

function summaryFixture(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsThreadCreate", enabled: true }],
    providers: [
      {
        id: "codex",
        kind: "codex",
        displayName: "Codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "plan"],
        defaultMode: "default",
        defaultModel: "gpt-5.6-sol",
        setupActions: [],
      },
      {
        id: "claude",
        kind: "claude",
        displayName: "Claude Code",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "review"],
        defaultMode: "review",
        defaultModel: "claude-opus-4-6",
        setupActions: [],
      },
    ],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

describe("canonical composer legacy Project adapter", () => {
  it("keeps only the executable legacy Hermes route available while the canonical catalog loads", () => {
    const catalog = createLegacyGlobalProviderCatalog({ hasProject: true });
    expect(catalog.instances).toMatchObject([
      { id: "hermes_default", driverKind: "hermes", availability: "available" },
      { id: "codex_default", driverKind: "codex", availability: "unavailable" },
    ]);
    expect(createCanonicalComposerSelection(catalog)).toMatchObject({
      instanceId: "hermes_default",
      model: "provider-default",
    });
  });

  it("only exposes capabilities the legacy Global Hermes route can execute", () => {
    const project = createLegacyProjectProviderCatalog(summaryFixture());
    const canonical: CanonicalProviderCatalog = {
      ...project,
      instances: [{
        ...project.instances[0]!,
        id: "hermes_default",
        driverKind: "hermes",
        models: [
          { ...project.instances[0]!.models[0]!, id: "current", displayName: "Current model" },
          { ...project.instances[0]!.models[0]!, id: "other", displayName: "Other model" },
        ],
        options: project.instances[0]!.options,
        defaultSelection: { instanceId: "hermes_default", model: "current" },
      }, ...project.instances],
    };

    const globalCatalog = filterCatalogForLegacyGlobal(canonical);

    expect(globalCatalog.instances.find((instance) => instance.id === "hermes_default"))
      .toMatchObject({
        availability: "available",
        models: [
          { id: "current", availability: "available" },
          { id: "other", availability: "unavailable" },
        ],
        options: [{ id: "effort" }],
      });
    expect(globalCatalog.instances.find((instance) => instance.driverKind === "codex"))
      .toMatchObject({ availability: "unavailable", models: [{ availability: "unavailable" }] });
  });

  it("projects current coding providers into canonical Instances", () => {
    const catalog = createLegacyProjectProviderCatalog(summaryFixture());

    expect(catalog.drivers.map((driver) => driver.kind)).toEqual([
      "hermes",
      "openclaw",
      "codex",
      "claude_code",
      "opencode",
      "pi",
    ]);
    expect(catalog.instances).toMatchObject([
      {
        id: "codex_default",
        driverKind: "codex",
        availability: "available",
        models: [{ id: "gpt-5.6-sol" }],
        options: [{ id: "effort", label: "Reasoning" }],
      },
      { id: "claude_code_default", driverKind: "claude_code", availability: "available", models: [{ id: "claude-opus-4-6" }] },
    ]);
  });

  it("keeps the shared catalog visible in Project Chat but gates Instances the legacy API cannot execute", () => {
    const summary = summaryFixture();
    const legacy = createLegacyProjectProviderCatalog(summary);
    const full: CanonicalProviderCatalog = {
      ...legacy,
      drivers: legacy.drivers,
      instances: [{
        ...legacy.instances[0]!,
        id: "hermes_default",
        driverKind: "hermes",
      }, ...legacy.instances],
    };

    const projectCatalog = filterCatalogForLegacyProject(full, summary);

    expect(projectCatalog.drivers.map((driver) => driver.kind))
      .toEqual(["hermes", "openclaw", "codex", "claude_code", "opencode", "pi"]);
    expect(projectCatalog.instances).toMatchObject([
      {
        id: "hermes_default",
        availability: "unavailable",
        models: [{ availability: "unavailable" }],
      },
      { id: "codex_default", availability: "available", options: [{ id: "effort" }], models: [{ displayName: "Provider default" }] },
      { id: "claude_code_default", availability: "available", options: [], models: [{ displayName: "Provider default" }] },
    ]);
  });

  it("blocks legacy dispatch when the selected controls cannot be represented by its request", () => {
    const summary = summaryFixture();
    const globalCatalog = filterCatalogForLegacyGlobal(createLegacyGlobalProviderCatalog({ hasProject: true }));
    const globalSelection = createCanonicalComposerSelection(globalCatalog)!;
    expect(legacyGlobalSelectionExecutable(globalCatalog, globalSelection)).toBe(true);
    expect(legacyGlobalSelectionExecutable(globalCatalog, {
      ...globalSelection,
      options: [{ id: "effort", value: "high" }],
    })).toBe(false);

    const projectCatalog = filterCatalogForLegacyProject(
      createLegacyProjectProviderCatalog(summary),
      summary,
    );
    const projectSelection = createCanonicalComposerSelection(projectCatalog, "codex_default")!;
    expect(legacyProjectSelectionExecutable(projectCatalog, summary, projectSelection)).toBe(true);
    expect(legacyProjectSelectionExecutable(projectCatalog, summary, {
      ...projectSelection,
      options: [{ id: "effort", value: "high" }],
    })).toBe(false);
  });

  it("does not let a stale legacy summary disable an available canonical Codex Instance", () => {
    const summary = { ...summaryFixture(), providers: summaryFixture().providers.slice(1) };
    const legacy = createLegacyProjectProviderCatalog(summaryFixture());
    const canonical: CanonicalProviderCatalog = {
      ...legacy,
      instances: legacy.instances.map((instance) => instance.driverKind === "codex"
        ? { ...instance, availability: "available" as const }
        : instance),
    };

    const projectCatalog = filterCatalogForLegacyProject(canonical, summary);

    expect(projectCatalog.instances.find((instance) => instance.driverKind === "codex"))
      .toMatchObject({ availability: "available", models: [{ availability: "available" }] });
  });

  it("restores the shared Driver catalog when an older Gateway only returns coding harnesses", () => {
    const summary = summaryFixture();
    const legacy = createLegacyProjectProviderCatalog(summary);
    const oldGatewayCatalog: CanonicalProviderCatalog = {
      ...legacy,
      drivers: legacy.drivers.filter((driver) => (
        driver.kind === "codex" || driver.kind === "claude_code"
      )),
    };

    expect(filterCatalogForLegacyProject(oldGatewayCatalog, summary).drivers.map((driver) => driver.kind))
      .toEqual(["hermes", "openclaw", "codex", "claude_code", "opencode", "pi"]);
  });

  it("maps canonical mode and permissions to the existing create-thread draft", () => {
    const summary = summaryFixture();
    const catalog = createLegacyProjectProviderCatalog(summary);
    const selection = {
      ...createCanonicalComposerSelection(catalog, "claude_code_default")!,
      interactionMode: "review",
      permissionMode: "full_access",
    };
    const current: AgentThreadComposerDraft = { providerId: "codex", prompt: "Keep me" };

    expect(applyCanonicalSelectionToAgentDraft(summary, catalog, current, selection)).toEqual({
      providerId: "claude",
      prompt: "Keep me",
      mode: "review",
      approvalPolicy: "never",
      sandboxMode: "full_access",
    });
  });

  it("maps a canonical coding Driver even when the legacy summary has not caught up", () => {
    const summary = { ...summaryFixture(), providers: summaryFixture().providers.slice(1) };
    const catalog = createLegacyProjectProviderCatalog(summaryFixture());
    const selection = createCanonicalComposerSelection(catalog, "codex_default")!;

    expect(applyCanonicalSelectionToAgentDraft(
      summary,
      catalog,
      { providerId: "claude", prompt: "Use Codex" },
      selection,
    )).toMatchObject({ providerId: "codex", prompt: "Use Codex" });
  });

  it("restores the canonical permission mode from an existing create-thread draft", () => {
    expect(permissionModeForAgentDraft({ prompt: "", approvalPolicy: "never", sandboxMode: "full_access" }))
      .toBe("full_access");
    expect(permissionModeForAgentDraft({ prompt: "", approvalPolicy: "on_failure", sandboxMode: "workspace_write" }))
      .toBe("auto");
    expect(permissionModeForAgentDraft({ prompt: "", approvalPolicy: "on_request", sandboxMode: "workspace_write" }))
      .toBe("supervised");
  });

  it("maps legacy provider ids back to stable canonical Instance ids", () => {
    const catalog = createLegacyProjectProviderCatalog(summaryFixture());
    expect(instanceIdForLegacyProvider(catalog, summaryFixture(), "claude"))
      .toBe("claude_code_default");
  });
});
