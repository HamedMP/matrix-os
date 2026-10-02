// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance } from "@matrix-os/contracts";
import { HarnessRail, HarnessIcon } from "../../packages/ui/src/agents-providers/HarnessRail";
afterEach(cleanup);
const agent = { id: "hermes", harness: "hermes", displayName: "Hermes", installState: "installed", authState: "unknown", enabled: false, configuredEnabled: true, connectivity: "unknown", accessSourceId: null, localObservation: { state: "present_unverified", checkedAt: "2026-01-01T00:00:00Z", staleAfter: "2026-01-01T00:00:05Z" } } as ProviderHarnessInstance;
const props = { harnesses: [agent], sources: [], selectedId: "hermes", disabled: false, canEnable: () => true, onSelect: vi.fn(), onEnable: vi.fn(), renderDetails: () => <div>Connection details</div> };
it("shows credential connection separately from inference readiness and removes Enable", () => {
  render(<HarnessRail {...props} />);
  expect(screen.getByRole("button", { name: /Hermes.*Connected/ })).toBeVisible();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByText(/Local login|Off in Settings|Enable this agent/)).not.toBeInTheDocument();
  expect(agent.authState).toBe("unknown");
});
it.each(["unauthenticated", "expired", "failed"] as const)("shows Not connected for explicit %s even with older credential observation", authState => {
  render(<HarnessRail {...props} harnesses={[{ ...agent, authState }]} />);
  expect(screen.getByRole("button", { name: /Hermes.*Not connected/ })).toBeVisible();
});
it("uses one invariant project-sized chevron through expand/collapse", () => {
  const view = render(<HarnessRail {...props} selectedId={null} />);
  const icon = view.container.querySelector(".matrix-ap-chevron svg")!;
  expect(icon).toHaveAttribute("width", "16");
  expect(icon).toHaveAttribute("height", "16");
  const path = icon.innerHTML;
  view.rerender(<HarnessRail {...props} />);
  expect(view.container.querySelector(".matrix-ap-chevron svg")!.innerHTML).toBe(path);
});
it.each([["opencode", "/agent-logos/opencode-white.png"], ["hermes", "/agent-logos/hermes-agent.png"], ["pi", "/agent-logos/pi-coding-agent.png"], ["openclaw", "/agent-logos/openclaw.svg"]] as const)("uses existing real %s artwork", (harness, src) => {
  const { container } = render(<HarnessIcon harness={harness} />);
  expect(container.querySelector("img")).toHaveAttribute("src", src);
  expect(container.querySelector(".matrix-ap-agent-lettermark")).toBeNull();
});

it("keeps the expanded agent when catalog inventory becomes a saved instance on refresh", async () => {
  const { AgentsProvidersView } = await import("../../packages/ui/src/agents-providers/AgentsProvidersView");
  const snapshot = { harnesses: [], harnessCatalog: [{ harness: "hermes", displayName: "Hermes", installState: "missing", available: true, runnable: false, setupAction: "install", safeReason: "not_installed" }], accessSources: [], accounts: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: "2026-01-01T00:00:00Z" } as unknown as import("@matrix-os/contracts").ProviderSettingsSnapshot;
  const p = { snapshot, selectedHarnessId: null, onSelectHarness: vi.fn(), onRefresh: vi.fn(), onMutate: vi.fn(), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn() };
  const view = render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /Hermes.*Not installed/ }));
  view.rerender(<AgentsProvidersView {...p} snapshot={{ ...snapshot, harnesses: [{ ...agent, accountIds: [], loginMethods: [], selectedAccountId: null, route: { kind: "configurable", providerId: "openai-codex", modelId: "test" } }], refreshedAt: "2026-01-01T00:00:08Z" }} />);
  expect(screen.getByRole("button", { name: /Hermes.*Connected/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("keeps historical explicit Off disconnected without a visible Enable or automatic mutation", () => {
  render(<HarnessRail {...props} harnesses={[{ ...agent, configuredEnabled: false }]} />);
  expect(screen.getByRole("button", { name: /Hermes.*Not connected/ })).toBeVisible();
  expect(props.onEnable).not.toHaveBeenCalled();
});

it("does not label an unsupported saved Hermes Matrix funding binding Connected", () => {
  const source = { id: "matrix_included", kind: "matrix_gateway", providerId: "anthropic", accountId: null, fundingKind: "matrix_included", readiness: { state: "ready" } } as unknown as import("@matrix-os/contracts").ProviderAccessSource;
  render(<HarnessRail {...props} sources={[source]} harnesses={[{ ...agent, authState: "authenticated", accessSourceId: source.id, route: { kind: "configurable", providerId: "anthropic", modelId: "test" } }]} />);
  expect(screen.getByRole("button", { name: /Hermes.*Not connected/ })).toBeVisible();
});
