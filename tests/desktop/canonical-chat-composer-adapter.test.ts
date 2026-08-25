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
  filterCatalogForLegacyProject,
  instanceIdForLegacyProvider,
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
  it("keeps Global Chat on its current Hermes harness while catalog loading", () => {
    const catalog = createLegacyGlobalProviderCatalog({ hasProject: true });
    expect(catalog.instances).toMatchObject([
      { id: "hermes_default", driverKind: "hermes", availability: "available" },
      { id: "codex_default", driverKind: "codex", availability: "available" },
    ]);
    expect(createCanonicalComposerSelection(catalog)?.instanceId).toBe("hermes_default");
  });

  it("projects current coding providers into canonical Instances", () => {
    const catalog = createLegacyProjectProviderCatalog(summaryFixture());

    expect(catalog.drivers.map((driver) => driver.kind)).toEqual(["codex", "claude_code"]);
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

  it("filters the full catalog to Instances the legacy create-thread API can execute", () => {
    const summary = summaryFixture();
    const legacy = createLegacyProjectProviderCatalog(summary);
    const full: CanonicalProviderCatalog = {
      ...legacy,
      drivers: [
        { kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
        ...legacy.drivers,
      ],
      instances: [{
        ...legacy.instances[0]!,
        id: "hermes_default",
        driverKind: "hermes",
      }, ...legacy.instances],
    };

    expect(filterCatalogForLegacyProject(full, summary).instances.map((instance) => instance.id))
      .toEqual(["codex_default", "claude_code_default"]);
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
