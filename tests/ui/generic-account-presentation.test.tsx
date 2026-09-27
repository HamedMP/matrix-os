// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsPanel } from "../../packages/ui/src/agents-providers/AccountsPanel.js";
import { nativeAccountPresentationFixture, ACCOUNT_PRESENTATION_NOW } from "../gateway/generic-account-presentation-fixture.js";

afterEach(() => vi.useRealTimers());
describe("harness-owned account presentation", () => {
  it.each(["pi", "opencode"] as const)("describes %s native authentication without inventing a connected Matrix account", async (harness) => {
    vi.useFakeTimers(); vi.setSystemTime(ACCOUNT_PRESENTATION_NOW);
    const snapshot = await nativeAccountPresentationFixture(harness);
    const selected = { ...snapshot.harnesses[0]!, accountIds: [] };
    render(<AccountsPanel harness={selected} accounts={[]} sources={snapshot.accessSources} allHarnesses={snapshot.harnesses}
      gatewayPolicy={null} attempt={null} disabled={false} canLogin={false} canLogout={false} canRemove={false} canReassign={false}
      onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(screen.queryByText("No account connected.")).not.toBeInTheDocument();
    expect(screen.getByText(`${selected.displayName} manages authentication for this route in Terminal.`)).toBeVisible();
    expect(screen.queryByTestId("account-owner_codex")).not.toBeInTheDocument();
    expect(snapshot.accessSources.find((source) => source.id === selected.accessSourceId)?.readiness.state).toBe("unknown");
  });
  it.each(["pi", "opencode"] as const)("preserves %s configured native identity when the effective binding is unavailable", async (harness) => {
    vi.useFakeTimers(); vi.setSystemTime(ACCOUNT_PRESENTATION_NOW);
    const snapshot = await nativeAccountPresentationFixture(harness);
    const selected = { ...snapshot.harnesses[0]!, accessSourceId: null, enabled: false, accountIds: [] };
    render(<AccountsPanel harness={selected} accounts={[]} sources={snapshot.accessSources} allHarnesses={snapshot.harnesses}
      gatewayPolicy={null} attempt={null} disabled={false} canLogin={false} canLogout={false} canRemove={false} canReassign={false}
      onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(screen.queryByText("No account connected.")).not.toBeInTheDocument();
    expect(screen.getByText(`${selected.displayName} manages authentication for this route in Terminal.`)).toBeVisible();
    expect(selected.accessSourceId).toBeNull();
    expect(selected.enabled).toBe(false);
  });
  it.each(["missing", "other_harness"] as const)("does not infer a native account from a %s configured binding", async (binding) => {
    const snapshot = await nativeAccountPresentationFixture("pi");
    const selected = { ...snapshot.harnesses[0]!, accessSourceId: null, enabled: false, accountIds: [],
      configuredAccessSourceId: binding === "missing" ? "missing_source" : snapshot.harnesses[0]!.configuredAccessSourceId };
    const sources = snapshot.accessSources.map((source) => source.kind === "harness_profile" ? { ...source, harness: "opencode" as const } : source);
    render(<AccountsPanel harness={selected} accounts={[]} sources={sources} allHarnesses={snapshot.harnesses}
      gatewayPolicy={null} attempt={null} disabled={false} canLogin={false} canLogout={false} canRemove={false} canReassign={false}
      onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(screen.queryByText(/manages authentication for this route/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-owner_codex")).not.toBeInTheDocument();
    expect(selected.accessSourceId).toBeNull();
    expect(selected.enabled).toBe(false);
  });
});
