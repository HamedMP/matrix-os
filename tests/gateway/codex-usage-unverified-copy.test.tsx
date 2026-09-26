// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema } from "@matrix-os/contracts";
import { buildBundledModelCatalog } from "../../packages/gateway/src/ai-providers/model-catalog.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { AccountsPanel } from "../../packages/ui/src/agents-providers/AccountsPanel.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Codex account usage copy from the V3 Settings projection", () => {
  it("keeps a local login observation separate from unverified usage and authentication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PROVIDER_SETTINGS_NOW);
    const canonical = providerSettingsCanonicalFixture();
    const unknown = {
      state: "unknown" as const,
      checkedAt: PROVIDER_SETTINGS_NOW.toISOString(),
      staleAfter: null,
      action: "retry" as const,
      safeReason: "unknown" as const,
    };
    canonical.accessSources.push({
      id: "owner_openai_profile", displayName: "Codex account", fundingKind: "owner_account",
      vendor: "openai", accountLabel: "Codex", eligibleModelIds: ["provider-default"],
      policyVersion: "policy_1", ...unknown,
      localObservation: {
        state: "present_unverified", checkedAt: PROVIDER_SETTINGS_NOW.toISOString(),
        staleAfter: new Date(PROVIDER_SETTINGS_NOW.getTime() + 5_000).toISOString(),
      },
    });
    canonical.accounts.push({
      id: "owner_codex", vendor: "openai", authMethod: "provider_profile",
      accountLabel: "Codex", ...unknown,
    });
    canonical.drivers.push({
      id: "codex", displayName: "Codex", kind: "cli", installState: "installed",
      health: "ready", capabilities: ["tools", "resume"], setupActions: [],
    });
    canonical.models.push(buildBundledModelCatalog().find((model) => model.vendor === "openai")!);
    canonical.instances.push({
      id: "codex_owner_openai_profile", driverId: "codex", vendor: "openai",
      accountId: "owner_codex", accessSourceId: "owner_openai_profile", label: "Codex",
      readiness: unknown, capabilitySnapshot: ["tools", "resume"],
      modelIds: ["provider-default"], defaultModelId: null, catalogVersion: "catalog_1",
    });
    const config: ProviderSettingsConfiguration = {
      schemaVersion: 1, revision: 1, accountProfiles: [], gatewayPolicy: null, receipts: [],
      harnesses: [{
        id: "harness_codex", driverId: "codex", harness: "codex", displayName: "Codex",
        accentColor: null, enabled: true, selectedAccountId: "owner_codex",
        accessSourceId: "owner_openai_profile",
        route: { kind: "fixed", providerId: "openai", modelId: "provider-default" },
      }],
    };
    const snapshot = await projectProviderSettings({
      canonical: AiProviderSnapshotV3Schema.parse(canonical), config,
      now: PROVIDER_SETTINGS_NOW, supportedActions: [],
    });
    const source = snapshot.accessSources.find((item) => item.id === "owner_openai_profile")!;
    const account = snapshot.accounts.find((item) => item.id === "owner_codex")!;
    const harness = snapshot.harnesses.find((item) => item.harness === "codex")!;
    expect(account).toMatchObject({ authState: "unknown", accessSourceId: source.id });
    expect(source.usage).toMatchObject({ kind: "unavailable", reason: "unknown" });

    render(<AccountsPanel
      harness={harness} accounts={[account]} sources={snapshot.accessSources}
      allHarnesses={snapshot.harnesses} gatewayPolicy={null} attempt={null}
      disabled canLogin={false} canLogout={false} canRemove={false} canReassign={false}
      onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()}
    />);
    const row = screen.getByTestId("account-owner_codex");
    expect(within(row).getByText(/Local login found; access not verified/)).toBeVisible();
    expect(within(row).getByText("Usage unavailable")).toBeVisible();
    expect(within(row).getByText("Unknown")).toBeVisible();
    expect(within(row).queryByText("Not Authenticated")).not.toBeInTheDocument();

    expect(snapshot.accessSources.find((item) => item.id === "matrix_included")?.usage)
      .toMatchObject({ kind: "unavailable", reason: "ledger_not_available" });
    for (const [state, reason] of [
      ["stale", "unknown"], ["unavailable", "unknown"],
      ["disabled", "unknown"], ["setup_required", "unknown"],
      ["auth_required", "not_authenticated"], ["invalid", "not_authenticated"],
      ["expired", "not_authenticated"], ["ready", "provider_does_not_report"],
    ] as const) {
      const other = structuredClone(canonical);
      const otherSource = other.accessSources.find((item) => item.id === "owner_openai_profile")!;
      otherSource.state = state;
      otherSource.action = state === "ready" ? "none" : "retry";
      otherSource.safeReason = state === "ready" ? null
        : ["auth_required", "invalid", "expired"].includes(state) ? "auth" : "unknown";
      const projected = await projectProviderSettings({
        canonical: AiProviderSnapshotV3Schema.parse(other), config,
        now: PROVIDER_SETTINGS_NOW, supportedActions: [],
      });
      expect(projected.accessSources.find((item) => item.id === "owner_openai_profile")?.usage,
        state).toMatchObject({ kind: "unavailable", reason });
    }
  });
});
