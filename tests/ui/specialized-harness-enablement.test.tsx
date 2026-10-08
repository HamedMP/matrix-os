// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView.js";

afterEach(cleanup);

describe("specialized harness Settings connections", () => {
  it.each(["claude", "codex"] as const)("does not expose manual enablement for %s or mutate disabled configuration", (kind) => {
    const snapshot: ProviderSettingsSnapshot = {
      contractVersion: 1, revision: 0, refreshedAt: "2026-09-27T00:00:00Z",
      projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 0 },
      access: { mode: "writable" }, configurationHarnessKinds: ["claude", "codex"],
      supportedActions: ["set_harness_enabled", "update_harness", "set_route", "select_account", "select_access_source"],
      harnessCatalog: [], modelProviders: [], accessSources: [], accounts: [], gatewayPolicy: null,
      harnesses: [{
        id: `harness_${kind}`, harness: kind, displayName: kind, accentColor: null,
        configuredEnabled: false, enabled: false, version: null, installState: "installed",
        authState: "unknown", loginMethods: [], recommendedLoginMethod: null, connectivity: "unknown",
        accountIds: [], selectedAccountId: null, accessSourceId: null,
        route: { kind: "fixed", providerId: kind === "claude" ? "anthropic" : "openai", modelId: "retained-model" },
        activeChatCount: 0,
      }],
    };
    const onMutate = vi.fn();
    render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={`harness_${kind}`} onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={onMutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button",{name:new RegExp(`^${kind}`)}));
    expect(screen.queryByRole("switch", { name: `Enable ${kind}` })).not.toBeInTheDocument();
    expect(screen.queryByText("Enable this agent")).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
    expect(snapshot.harnesses[0]!.configuredEnabled).toBe(false);
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
  });
});
