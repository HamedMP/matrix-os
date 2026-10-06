// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance, ProviderWorkflow, ProviderWorkflowCapability } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
afterEach(cleanup);
const harness = { id: "codex", harness: "codex", displayName: "Codex", installState: "installed", authState: "unauthenticated" } as ProviderHarnessInstance;
const capability: ProviderWorkflowCapability = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false };
function setup(options: { state?: ProviderWorkflow["state"]; capability?: ProviderWorkflowCapability; forbidden?: boolean; disabled?: boolean } = {}) {
  const operation: ProviderWorkflow = { id: "restored-login", harnessInstanceId: "codex", kind: "login", state: options.state ?? "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_owner:tt_login", deviceCode: null, authorizationUrl: null, safeFailure: null };
  const api = { get: options.forbidden ? vi.fn().mockRejectedValue(new ProviderWorkflowClientError("forbidden")) : vi.fn().mockResolvedValue(operation), start: vi.fn(), cancel: vi.fn(), capabilities: vi.fn(), submitKey: vi.fn(), logs: vi.fn() } satisfies ProviderWorkflowClient;
  const onOpenTerminal = vi.fn();
  render(<HarnessWorkflowPanel harness={harness} capability={options.capability ?? capability} client={api} disabled={options.disabled ?? false} onRefresh={vi.fn()} onOpenTerminal={onOpenTerminal} operationId={operation.id} />);
  return { api, onOpenTerminal };
}
it("reopens the exact restored terminal-only login from Advanced without starting another login", async () => {
  const { api, onOpenTerminal } = setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in in Terminal" })).toBeDisabled());
  const summary = screen.getByText("Advanced configuration");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  expect(onOpenTerminal).not.toHaveBeenCalled();
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
  await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledWith("tws_owner:tt_login"));
  expect(api.start).not.toHaveBeenCalled();
});
it.each(["succeeded", "cancelled", "expired", "failed"] as const)("does not reopen a %s login receipt", async state => {
  const { api, onOpenTerminal } = setup({ state });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  expect(onOpenTerminal).not.toHaveBeenCalled();
});
it.each(["device_code", "existing_codex"] as const)("keeps restored %s login in Settings even when its receipt has a Terminal reference", async method => {
  const { api, onOpenTerminal } = setup({ capability: { ...capability, loginMethods: [method, "terminal"] } });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByText("Advanced configuration")).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  expect(onOpenTerminal).not.toHaveBeenCalled();
});
it("does not offer a Terminal continuation for key-only or unadvertised login", async () => {
  const { api } = setup({ capability: { ...capability, loginMethods: [], apiKeyProviders: ["openai"] } });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
});
it("does not offer a restored Terminal continuation after owner denial", async () => {
  const { onOpenTerminal, api } = setup({ forbidden: true });
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  expect(onOpenTerminal).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
});
it("disables the restored continuation when mutations are unavailable", async () => {
  const { onOpenTerminal } = setup({ disabled: true });
  fireEvent.click(screen.getByText("Advanced configuration"));
  const continuation = await screen.findByRole("button", { name: "Continue in Terminal" });
  expect(continuation).toBeDisabled();
  fireEvent.click(continuation);
  expect(onOpenTerminal).not.toHaveBeenCalled();
});

it("removes the continuation when a later status read denies owner access", async () => {
  vi.useFakeTimers();
  try {
    const { api, onOpenTerminal } = setup();
    await act(async () => {});
    fireEvent.click(screen.getByText("Advanced configuration"));
    expect(screen.getByRole("button", { name: "Continue in Terminal" })).toBeEnabled();
    api.get.mockRejectedValue(new ProviderWorkflowClientError("forbidden"));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
    expect(onOpenTerminal).not.toHaveBeenCalled();
  } finally { cleanup(); vi.useRealTimers(); }
});
