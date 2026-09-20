// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";

function snapshot(): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
    revision: 1, refreshedAt: new Date().toISOString(), access: { mode: "writable" },
    configurationHarnessKinds: ["pi"], harnessCatalog: [],
    harnesses: [{
      id: "pi", harness: "pi", displayName: "Pi", accentColor: null, enabled: true,
      version: "1.0", installState: "installed", authState: "unknown", connectivity: "unknown",
      loginMethods: [], recommendedLoginMethod: null, accountIds: [], selectedAccountId: null,
      accessSourceId: null, route: { kind: "configurable", providerId: "anthropic", modelId: "sonnet" },
      activeChatCount: 0,
    }],
    modelProviders: [{ id: "anthropic", displayName: "Anthropic", models: [{ id: "sonnet", displayName: "Sonnet", enabled: true }] }],
    accounts: [], accessSources: [], gatewayPolicy: null,
    supportedActions: ["add_harness", "update_harness"],
  } as ProviderSettingsSnapshot;
}

function setup(value = snapshot(), overrides: Partial<React.ComponentProps<typeof AgentsProvidersView>> = {}) {
  const onSelectHarness = vi.fn();
  const onRefresh = vi.fn();
  const onMutate = vi.fn();
  const result = render(<AgentsProvidersView snapshot={value} selectedHarnessId="pi"
    onSelectHarness={onSelectHarness} onRefresh={onRefresh} onMutate={onMutate}
    onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} {...overrides} />);
  return { ...result, onRefresh, onSelectHarness, onMutate };
}

function fundedSnapshot(): ProviderSettingsSnapshot {
  const value = snapshot();
  value.accessSources = [{
    id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included",
    providerId: "anthropic", accountId: null, displayName: "Matrix AI", eligibleModelIds: ["sonnet"],
    readiness: { state: "ready", checkedAt: value.refreshedAt, staleAfter: null, action: "none", safeReason: null },
    usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "owner_entitlement", reason: "ledger_not_available", asOf: null },
  }];
  value.gatewayPolicy = { accessSourceId: "matrix_included", monthlyBudgetMicrousd: 1_000_000, allowedModelIds: ["sonnet"], topUpEnabled: false };
  Object.assign(value, { supportedActions: ["set_route"] });
  return value;
}

afterEach(cleanup);

describe("provider setup presentation", () => {
  it("keeps Matrix AI first and explains missing setup even without any agents", () => {
    const value = snapshot();
    value.harnesses = [];
    setup(value);
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Setup needed")).toBeVisible();
    expect(within(gateway).getByText(/not enabled for this computer/i)).toBeVisible();
    expect(within(gateway).queryByText(/\$0/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add agent" })).toBeVisible();
  });

  it("uses expandable agent rows and keeps customization collapsed", () => {
    const { container, onSelectHarness } = setup();
    const row = screen.getByRole("button", { name: /Pi.*Check failed/ });
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row.querySelector("img")).toHaveAttribute("src", "/agent-logos/pi-coding-agent.png");
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(gateway.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("details.matrix-ap-advanced")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Display name")).not.toBeVisible();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(onSelectHarness).toHaveBeenCalledWith("pi");
  });

  it("shows unsupported route controls as readable values, not disabled selectors", () => {
    setup();
    expect(screen.queryByRole("combobox", { name: "Paid through" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Model provider" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Advanced settings"));
    expect(screen.getByText("No access connected")).toBeVisible();
  });

  it("provides a retry for absent gateway setup without inventing a use action", () => {
    const { onRefresh, onMutate } = setup();
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    fireEvent.click(within(gateway).getByRole("button", { name: "Check again" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(within(gateway).queryByRole("button", { name: "Use Matrix AI" })).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("connects an eligible agent through an exact canonical Matrix AI route", () => {
    const { onMutate } = setup(fundedSnapshot());
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    fireEvent.click(within(gateway).getByText("Usage & available models"));
    expect(within(gateway).getByText("$1.00")).toBeVisible();
    expect(within(gateway).getByText("Sonnet")).toBeVisible();
    expect(within(gateway).queryByRole("textbox", { name: "Monthly budget in USD" })).not.toBeInTheDocument();
    fireEvent.click(within(gateway).getByRole("button", { name: "Use Matrix AI" }));
    expect(onMutate).toHaveBeenCalledWith({ type: "set_route", harnessInstanceId: "pi",
      route: { kind: "configurable", providerId: "anthropic", modelId: "sonnet" }, accessSourceId: "matrix_included", accountId: null, enableHarness: true });
    expect(within(gateway).queryByText("Selected for Pi")).not.toBeInTheDocument();
  });

  it("never offers activation for a blocked model or read-only session", () => {
    const value = fundedSnapshot();
    value.gatewayPolicy!.allowedModelIds = [];
    const { unmount } = setup(value);
    expect(screen.getByRole("button", { name: /Use Matrix AI/ })).toBeDisabled();
    unmount();
    const readOnly = fundedSnapshot();
    readOnly.access = { mode: "read_only", reason: "remote_policy" };
    setup(readOnly);
    for (const button of screen.getAllByRole("button", { name: /Use Matrix AI/ })) expect(button).toBeDisabled();
  });

  it("enables a disabled agent atomically when choosing Matrix AI", () => {
    const value = fundedSnapshot();
    value.harnesses[0]!.enabled = false;
    const { onMutate } = setup(value);
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).queryByText(/Enable Pi below before starting a chat/)).not.toBeInTheDocument();
    fireEvent.click(within(gateway).getByRole("button", { name: "Use Matrix AI" }));
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ type: "set_route", enableHarness: true }));
    expect(onMutate).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_harness_enabled" }));
  });

  it("offers a compatible-agent navigation action when Hermes is selected", () => {
    const value = fundedSnapshot();
    value.harnesses.push({ ...value.harnesses[0]!, id: "hermes", harness: "hermes", displayName: "Hermes" });
    const { onSelectHarness, onMutate } = setup(value, { selectedHarnessId: "hermes" });
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    fireEvent.click(within(gateway).getByRole("button", { name: "Choose Pi" }));
    expect(onSelectHarness).toHaveBeenCalledWith("pi");
    expect(onMutate).not.toHaveBeenCalled();
    expect(within(gateway).queryByRole("button", { name: "Use Matrix AI" })).not.toBeInTheDocument();
  });

  it("repairs a saved Matrix route whose model is no longer allowed", () => {
    const value = fundedSnapshot();
    value.harnesses[0]!.accessSourceId = "matrix_included";
    value.harnesses[0]!.route.modelId = "retired";
    const { onMutate } = setup(value);
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).queryByText("Selected for Pi")).not.toBeInTheDocument();
    expect(within(gateway).getByText(/Saved Matrix model unavailable/)).toBeVisible();
    fireEvent.click(within(gateway).getByRole("button", { name: "Use Matrix AI" }));
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ route: { kind: "configurable", providerId: "anthropic", modelId: "sonnet" } }));
  });

  it("keeps exactly one visible Terminal setup action for a missing agent", async () => {
    const value = snapshot();
    value.harnesses[0]!.installState = "missing";
    const onSetupHarness = vi.fn().mockResolvedValue(true);
    setup(value, { onSetupHarness });
    expect(screen.getByRole("button", { name: "Connect Pi" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Set up Pi" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Pi" }));
    expect(onSetupHarness).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Pi" })).toBeEnabled());
  });

  it.each(["hermes", "openclaw"] as const)("does not offer Matrix funding for an unimplemented %s route", (kind) => {
    const value = fundedSnapshot();
    value.configurationHarnessKinds = [kind];
    value.harnesses[0]!.harness = kind;
    value.harnesses[0]!.displayName = kind;
    const ownSource = { ...value.accessSources[0]!, id: "owner", kind: "provider_account" as const, fundingKind: "owner_api_key" as const, accountId: "owner_account", displayName: "My API key" };
    value.accessSources.push(ownSource);
    value.harnesses[0]!.accessSourceId = ownSource.id;
    Object.assign(value, { supportedActions: ["set_route", "select_access_source", "add_harness"] });
    value.harnessCatalog = [{ harness: kind, displayName: kind, installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null }];
    setup(value);
    fireEvent.click(screen.getByText("Advanced settings"));
    const access = screen.getByRole("combobox", { name: "Paid through" });
    expect(within(access).getByRole("option", { name: "My API key" })).toBeInTheDocument();
    expect(within(access).queryByRole("option", { name: "Matrix AI" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: `${kind} configuration` })).getByText(/Matrix AI funding is not supported for this agent yet/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    const connections = within(dialog).getByLabelText("Use AI through");
    expect(within(connections).getByRole("option", { name: "My API key" })).toBeInTheDocument();
    expect(within(connections).queryByRole("option", { name: "Matrix AI" })).not.toBeInTheDocument();
  });

  it.each(["hermes", "openclaw"] as const)("marks a legacy %s Matrix connection unavailable instead of claiming readiness", (kind) => {
    const value = fundedSnapshot();
    value.configurationHarnessKinds = [kind];
    Object.assign(value.harnesses[0]!, { harness: kind, displayName: kind, accessSourceId: "matrix_included",
      enabled: true, installState: "installed", connectivity: "online", authState: "authenticated" });
    setup(value);
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(screen.getByRole("button", { name: new RegExp(`${kind}.*Check access`) })).toBeVisible();
    expect(within(gateway).queryByText(`Selected for ${kind}`)).not.toBeInTheDocument();
    expect(screen.getByText("Choose a supported connection", { selector: "strong" })).toBeVisible();
    expect(screen.queryByText("This agent uses Matrix AI. No provider account is required.")).not.toBeInTheDocument();
  });

  it.each(["unauthenticated", "expired"] as const)("shows actionable %s authentication with projected unknown connectivity", (authState) => {
    const value = fundedSnapshot();
    Object.assign(value.harnesses[0]!, { authState, connectivity: "unknown", accessSourceId: "matrix_included" });
    value.accessSources[0]!.readiness.state = authState === "expired" ? "expired" : "auth_required";
    value.accessSources[0]!.readiness.action = "open_terminal";
    setup(value);
    expect(screen.getByRole("button", { name: /Pi.*Sign in/ })).toBeVisible();
  });

  it("preserves explicit offline status even when authentication is expired", () => {
    const value = snapshot();
    Object.assign(value.harnesses[0]!, { authState: "expired", connectivity: "offline" });
    setup(value);
    expect(screen.getByRole("button", { name: /Pi.*Check failed/ })).toBeVisible();
  });
});
