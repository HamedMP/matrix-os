// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance } from "@matrix-os/contracts";
import { HarnessRail } from "../../packages/ui/src/agents-providers/HarnessRail";

afterEach(cleanup);
const harness = (
  kind: ProviderHarnessInstance["harness"],
  changes: Partial<ProviderHarnessInstance> = {},
): ProviderHarnessInstance =>
  ({
    id: kind,
    harness: kind,
    displayName: kind,
    installState: "installed",
    authState: "unauthenticated",
    connectivity: "online",
    enabled: true,
    configuredEnabled: true,
    accessSourceId: null,
    accountIds: [],
    selectedAccountId: null,
    loginMethods: [],
    route: { kind: "configurable", providerId: "anthropic", modelId: "test" },
    ...changes,
  }) as ProviderHarnessInstance;
it("groups every instance and orders coding agents without losing general instances", () => {
  render(
    <HarnessRail
      harnesses={[
        harness("hermes"),
        harness("pi"),
        harness("codex"),
        harness("claude"),
        harness("opencode"),
        harness("openclaw"),
      ]}
      sources={[]}
      selectedId={null}
      disabled={false}
      canEnable={() => true}
      onSelect={vi.fn()}
      onEnable={vi.fn()}
      renderDetails={() => null}
    />,
  );
  const coding = screen.getByRole("region", { name: "Coding agents" });
  expect(
    within(coding)
      .getAllByRole("button")
      .map((item) => item.textContent),
  ).toEqual([
    expect.stringContaining("claude"),
    expect.stringContaining("codex"),
    expect.stringContaining("opencode"),
    expect.stringContaining("pi"),
  ]);
  expect(
    within(screen.getByRole("region", { name: "General agents" })).getAllByRole(
      "button",
    ),
  ).toHaveLength(2);
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});
it("shows missing and disconnected accounts without Enable controls", () => {
  render(
    <HarnessRail
      harnesses={[
        harness("claude", { installState: "missing" }),
        harness("pi", { authState: "expired" }),
        harness("hermes", { enabled: false, configuredEnabled: false }),
      ]}
      sources={[]}
      selectedId="hermes"
      disabled={false}
      canEnable={() => true}
      onSelect={vi.fn()}
      onEnable={vi.fn()}
      renderDetails={() => <p>Details</p>}
    />,
  );
  expect(screen.getByText("Not installed")).toBeInTheDocument();
  expect(screen.getAllByText("Not connected")).toHaveLength(2);
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});
it("shows absent catalog agents using authoritative workflow targets without route mutations", async () => {
  const { AgentsProvidersView } = await import(
    "../../packages/ui/src/agents-providers/AgentsProvidersView"
  );
  const capability = {
    harnessInstanceId: "harness_hermes",
    harness: "hermes" as const,
    displayName: "Hermes",
    installState: "missing" as const,
    loginMethods: [],
    apiKeyProviders: [],
    install: true,
    uninstall: false,
    logs: true,
  };
  const { waitFor, fireEvent } = await import("@testing-library/react");
  const { ProviderSettingsController } = await import(
    "../../packages/ui/src/agents-providers/provider-settings-controller"
  );
  const onMutate = vi.fn();
  const start = vi.fn().mockResolvedValue({
    id: "wf",
    harnessInstanceId: "harness_hermes",
    kind: "install",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: null,
    deviceCode: null,
    authorizationUrl: null,
    safeFailure: null,
  });
  const workflowClient = {
    capabilities: vi.fn().mockResolvedValue([capability]),
    start,
    get: vi.fn(),
    cancel: vi.fn(),
    submitKey: vi.fn(),
    logs: vi.fn(),
  };
  const snapshot = {
    contractVersion: 1,
    projectionOf: {
      contract: "AiProviderSnapshotV3",
      contractVersion: 3,
      revision: 0,
    },
    revision: 0,
    harnessCatalog: ["hermes", "openclaw", "pi", "opencode"].map((kind) => ({
      harness: kind,
      displayName: kind,
      installState: "missing",
      available: false,
      runnable: false,
      setupAction: "none",
      safeReason: "runtime_not_supported",
    })),
    harnesses: [],
    accessSources: [],
    modelProviders: [],
    accounts: [],
    gatewayPolicy: null,
    configurationHarnessKinds: [],
    supportedActions: [],
    access: { mode: "writable" },
    refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as import("@matrix-os/contracts").ProviderSettingsSnapshot;
  const controller = new ProviderSettingsController({
    identityKey: "inventory_runtime",
    transport: {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      mutate: vi.fn(),
    },
  });
  await controller.refresh();
  expect(controller.getState().snapshot).toEqual(snapshot);
  const props = {
    snapshot: controller.getState().snapshot!,
    selectedHarnessId: null,
    onSelectHarness: controller.selectHarness,
    onMutate,
    onRefresh: vi.fn(),
    onOpenTerminal: vi.fn(),
    onOpenBrowser: vi.fn(),
    onAddCredit: vi.fn(),
    workflowClient,
  };
  render(<AgentsProvidersView {...props} />);
  await screen.findByRole("button", { name: /Hermes.*Not installed/ });
  fireEvent.click(
    screen.getByRole("button", { name: /Hermes.*Not installed/ }),
  );
  expect(
    screen.getByRole("button", { name: /Hermes.*Not installed/ }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(controller.getState().selectedHarnessId).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessInstanceId: "harness_hermes",
        kind: "install",
      }),
      expect.any(AbortSignal),
    ),
  );
  expect(onMutate).not.toHaveBeenCalled();
  controller.dispose();
});
it("starts with every agent collapsed and opens or closes the chosen accordion", async () => {
  const { AgentsProvidersView } = await import(
    "../../packages/ui/src/agents-providers/AgentsProvidersView"
  );
  const { fireEvent } = await import("@testing-library/react");
  const snapshot = {
    harnesses: [harness("codex")],
    accessSources: [],
    modelProviders: [],
    accounts: [],
    gatewayPolicy: null,
    configurationHarnessKinds: ["codex"],
    supportedActions: ["set_harness_enabled"],
    access: { mode: "writable" },
    refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as import("@matrix-os/contracts").ProviderSettingsSnapshot;
  render(
    <AgentsProvidersView
      snapshot={snapshot}
      selectedHarnessId="codex"
      onSelectHarness={vi.fn()}
      onMutate={vi.fn()}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenBrowser={vi.fn()}
      onAddCredit={vi.fn()}
    />,
  );
  const row = screen.getByRole("button", { name: /^codex/ });
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  fireEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  fireEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "false");
});
it("renders real capabilities alongside approved purposes and omits unknown metadata", async () => {
  const { GatewayPanel } = await import(
    "../../packages/ui/src/agents-providers/GatewayPanel"
  );
  const source = {
    id: "matrix",
    kind: "matrix_gateway",
    eligibleModelIds: ["claude-sonnet-5", "@cf/zai-org/glm-5.3-flash", "unknown"],
    readiness: { state: "ready" },
    usage: { kind: "unavailable", reason: "unknown" },
  } as unknown as import("@matrix-os/contracts").ProviderAccessSource;
  const policy = {
    allowedModelIds: ["claude-sonnet-5", "@cf/zai-org/glm-5.3-flash", "unknown"],
    monthlyBudgetMicrousd: null,
    topUpEnabled: false,
  } as unknown as import("@matrix-os/contracts").ProviderGatewayPolicy;
  render(
    <GatewayPanel
      source={source}
      policy={policy}
      provider={{
        id: "provider",
        displayName: "Provider",
        models: [
          {
            id: "claude-sonnet-5",
            displayName: "Known",
            enabled: true,
            capabilities: ["tools", "vision"],
          },
          { id: "@cf/zai-org/glm-5.3-flash", displayName: "GLM", enabled: true },
          { id: "unknown", displayName: "Unknown", enabled: true },
        ],
      }}
      disabled={false}
      canSetBudget={false}
      canSetAllowlist={false}
      canAddCredit={false}
      onMutate={vi.fn()}
      onAddCredit={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(screen.getByText("Tools")).toBeVisible();
  expect(screen.getByText("Vision")).toBeVisible();
  expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  expect(screen.getByText("Coding")).toBeVisible();
  expect(screen.getByText("General")).toBeVisible();
  const sonnetRow = screen.getByText("Known").closest("li");
  expect(sonnetRow).toContainElement(screen.getByText("Coding"));
  expect(sonnetRow).toContainElement(screen.getByText("Tools"));
  expect(sonnetRow).toContainElement(screen.getByText("Vision"));
});
it("wires Change account inside the authenticated shared account card", async () => {
  const { AgentsProvidersView } = await import(
    "../../packages/ui/src/agents-providers/AgentsProvidersView"
  );
  const { fireEvent } = await import("@testing-library/react");
  const snapshot = {
    harnesses: [
      harness("codex", {
        authState: "authenticated",
        accountIds: ["owner"],
        selectedAccountId: "owner",
      }),
    ],
    accounts: [
      {
        id: "owner",
        displayName: "Owner",
        authState: "authenticated",
        authMethod: "api_key",
        accessSourceId: "profile",
      },
    ],
    accessSources: [
      {
        id: "profile",
        readiness: { state: "ready" },
        usage: { kind: "unavailable", reason: "unknown" },
      },
    ],
    modelProviders: [],
    gatewayPolicy: null,
    configurationHarnessKinds: [],
    supportedActions: [],
    access: { mode: "writable" },
    refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as import("@matrix-os/contracts").ProviderSettingsSnapshot;
  const workflowClient = {
    capabilities: vi.fn().mockResolvedValue([
      {
        harnessInstanceId: "codex",
        harness: "codex",
        displayName: "Codex",
        installState: "installed",
        loginMethods: [],
        apiKeyProviders: ["openai"],
        install: false,
        uninstall: false,
        logs: false,
      },
    ]),
    start: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    submitKey: vi.fn(),
    logs: vi.fn(),
  };
  render(
    <AgentsProvidersView
      snapshot={snapshot}
      selectedHarnessId="codex"
      onSelectHarness={vi.fn()}
      onMutate={vi.fn()}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenBrowser={vi.fn()}
      onAddCredit={vi.fn()}
      workflowClient={workflowClient}
    />,
  );
  await import("@testing-library/react").then(({ waitFor }) =>
    waitFor(() => expect(workflowClient.capabilities).toHaveBeenCalled()),
  );
  fireEvent.click(screen.getByRole("button", { name: /^codex/ }));
  const action = await screen.findByRole("button", { name: "Change account" });
  expect(action.closest(".matrix-ap-account")).toBeVisible();
  expect(screen.queryByTestId("account-owner")).not.toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Change account" }),
  ).toHaveLength(1);
  fireEvent.click(action);
  expect(screen.getByRole("button", { name: /API key/ })).toBeInTheDocument();
});
it("recovers an owner-scoped active operation on a fresh Settings view and cancels it", async () => {
  const { AgentsProvidersView } = await import(
    "../../packages/ui/src/agents-providers/AgentsProvidersView"
  );
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const operation = {
    id: "wf_reopened",
    harnessInstanceId: "harness_hermes",
    kind: "install" as const,
    state: "running" as const,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: null,
    deviceCode: null,
    authorizationUrl: null,
    safeFailure: null,
  };
  const workflowClient = {
    capabilities: vi
      .fn()
      .mockResolvedValue([
        {
          harnessInstanceId: "harness_hermes",
          harness: "hermes",
          displayName: "Hermes",
          installState: "missing",
          loginMethods: [],
          apiKeyProviders: [],
          install: true,
          uninstall: false,
          logs: false,
          activeOperationId: operation.id,
        },
        { harnessInstanceId: "harness_codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: [], install: false, uninstall: false, logs: false },
        { harnessInstanceId: "harness_claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: [], install: false, uninstall: false, logs: false },
      ]),
    start: vi.fn(),
    get: vi.fn().mockResolvedValue(operation),
    cancel: vi.fn().mockResolvedValue({ ...operation, state: "cancelled" }),
    submitKey: vi.fn(),
    submitCode: vi.fn(),
    logs: vi.fn(),
  };
  const snapshot = {
    harnesses: [],
    accounts: [],
    accessSources: [],
    modelProviders: [],
    gatewayPolicy: null,
    configurationHarnessKinds: [],
    supportedActions: [],
    access: { mode: "writable" },
    refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as import("@matrix-os/contracts").ProviderSettingsSnapshot;
  const refresh = vi.fn();
  render(
    <AgentsProvidersView
      snapshot={snapshot}
      selectedHarnessId={null}
      onSelectHarness={vi.fn()}
      onMutate={vi.fn()}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
      onOpenBrowser={vi.fn()}
      onAddCredit={vi.fn()}
      workflowClient={workflowClient}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Hermes.*Not installed/ }),
  );
  await screen.findByRole("button", { name: /Hermes.*Installing/ });
  fireEvent.click(screen.getByRole("button", { name: /Codex.*Not connected/ }));
  // A stale hosted Codex advertisement must not restore an excluded subscription entry.
  expect(screen.queryByRole("button", { name: /ChatGPT account/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Claude Code.*Not connected/ }));
  await screen.findByRole("button", { name: /Claude account/ });
  expect(screen.getByRole("button", { name: /Hermes.*Installing/ })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: /Hermes.*Installing/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(workflowClient.cancel).toHaveBeenCalledWith(
      operation.id,
      expect.any(AbortSignal),
    ),
  );
  expect(workflowClient.get).toHaveBeenCalledWith(
    operation.id,
    expect.any(AbortSignal),
  );
  expect(workflowClient.start).not.toHaveBeenCalled();
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it("keeps Matrix AI policy and purchase restrictions out of persistent overview prose", async () => {
  const { GatewayPanel } = await import("../../packages/ui/src/agents-providers/GatewayPanel");
  const source = { id: "matrix", kind: "matrix_gateway", eligibleModelIds: [], readiness: { state: "unavailable", safeReason: "policy", action: "contact_owner" }, usage: { kind: "unavailable", reason: "unknown" } } as unknown as import("@matrix-os/contracts").ProviderAccessSource;
  const policy = { allowedModelIds: [], monthlyBudgetMicrousd: null, topUpEnabled: false } as unknown as import("@matrix-os/contracts").ProviderGatewayPolicy;
  render(<GatewayPanel source={source} policy={policy} provider={null} disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit={false} onMutate={vi.fn()} onAddCredit={vi.fn()} onRefresh={vi.fn()} />);
  expect(screen.queryByText("Matrix AI is restricted by your workspace. Ask your administrator.")).not.toBeInTheDocument();
  expect(screen.queryByText("Matrix AI credit purchases are not available yet.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again", hidden: true })).toHaveAttribute("title", "Matrix AI is restricted by your workspace. Ask your administrator.");
  expect(screen.getByRole("button", { name: "Buy credit" })).toBeEnabled();
});

it("keeps missing-runtime purchase explanations out of the overview while showing honest unavailable credit", async () => {
  const { GatewayPanel } = await import("../../packages/ui/src/agents-providers/GatewayPanel");
  render(<GatewayPanel source={null} policy={null} provider={null} disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit={false} onMutate={vi.fn()} onAddCredit={vi.fn()} onRefresh={vi.fn()} />);
  expect(screen.queryByText(/Credit purchases are unavailable/)).not.toBeInTheDocument();
  expect(screen.getByText("Chat credit unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Buy credit" })).toBeEnabled();
});

it("restores Buy credit without starting unsupported checkout and allows refresh", async () => {
  const { GatewayPanel } = await import("../../packages/ui/src/agents-providers/GatewayPanel");
  const onAddCredit = vi.fn(); const onRefresh = vi.fn();
  render(<GatewayPanel source={null} policy={null} provider={null} disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit={false} onMutate={vi.fn()} onAddCredit={onAddCredit} onRefresh={onRefresh} />);
  fireEvent.click(screen.getByRole("button", {name: "Buy credit"}));
  const dialog = screen.getByRole("dialog", {name: "Add Matrix AI credit"});
  expect(within(dialog).getByText("Purchase availability has not been confirmed for this computer. Refresh to check again.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", {name: "Continue to checkout"})).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", {name: "Close"})).toBeEnabled();
  fireEvent.click(within(dialog).getByRole("button", {name: "Check again"}));
  expect(onRefresh).toHaveBeenCalledOnce(); expect(onAddCredit).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, {key: "Escape"});
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
