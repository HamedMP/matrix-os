// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../../packages/ui/src/agents-providers/types";

afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(kind: "claude" | "codex") {
  vi.useFakeTimers();
  const option = { id: kind === "codex" ? "openai_terminal" : "anthropic_terminal", providerId: kind === "codex" ? "openai" : "anthropic", authKind: "subscription", method: "terminal", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
  const capability: ProviderWorkflowUICapability = { harnessInstanceId: kind, harness: kind, displayName: kind, installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false, connectionOptions: [option] };
  const operation = { id: "retained", harnessInstanceId: kind, kind: "login", state: "running", expiresAt: new Date(Date.now() + 10000).toISOString(), terminalSessionId: "tws_owner:tt_login", deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: option } as const;
  const client = { capabilities: vi.fn(), get: vi.fn().mockResolvedValue(operation), start: vi.fn(), startConnection: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() } satisfies ProviderWorkflowClient;
  const open = vi.fn();
  render(<HarnessWorkflowPanel harness={{ id: kind, harness: kind, displayName: kind, installState: "installed", authState: "unauthenticated" }} capability={capability} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={open} operationId={operation.id} />);
  return { client, open, operation };
}
it.each(["claude", "codex"] as const)("keeps %s Terminal continuation through a transient read and successful retry", async kind => {
  const { client, open, operation } = setup(kind);
  await act(async () => {});
  client.get.mockRejectedValueOnce(new ProviderWorkflowClientError("unavailable"));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole("alert")).toHaveTextContent("Connection status is unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
  await act(async () => {});
  expect(open).toHaveBeenCalledExactlyOnceWith(operation.terminalSessionId);
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(client.get).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: "Continue in Terminal" })).toBeEnabled();
  expect(client.start).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
});
it.each(["forbidden", "unauthorized", "unsupported"] as const)("hides Terminal on non-retryable %s after a previous transient error", async reason => {
  const { client, open } = setup("codex");
  await act(async () => {});
  client.get.mockRejectedValueOnce(new ProviderWorkflowClientError("unavailable"));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  client.get.mockRejectedValueOnce(new ProviderWorkflowClientError(reason));
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});
it("hides Terminal at receipt expiry even while reads are temporarily unavailable", async () => {
  const { client } = setup("codex");
  await act(async () => {});
  client.get.mockRejectedValue(new ProviderWorkflowClientError("unavailable"));
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
});
it("hides Terminal when polling returns a mismatched workflow", async () => {
  const { client, operation } = setup("codex");
  await act(async () => {});
  client.get.mockResolvedValue({ ...operation, harnessInstanceId: "other" });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
});
it("hides Codex Terminal when the receipt option is no longer supported", async () => {
  const kind = "codex";
  const { client, operation } = setup(kind);
  await act(async () => {});
  client.get.mockResolvedValue({ ...operation, connectionOption: { ...operation.connectionOption, id: "stale_terminal" } });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
});
it.each(["forbidden", "mismatched"] as const)("blocks Terminal after a manual status check is %s and restores it only after a valid check", async failure => {
  const { client, operation, open } = setup("codex");
  await act(async () => {});
  client.get.mockRejectedValueOnce(new ProviderWorkflowClientError("unavailable"));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  if (failure === "forbidden") client.get.mockRejectedValueOnce(new ProviderWorkflowClientError("forbidden"));
  else client.get.mockResolvedValueOnce({ ...operation, harnessInstanceId: "other" });
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  client.get.mockRejectedValueOnce(new ProviderWorkflowClientError("unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Continue in Terminal" })).toBeEnabled();
  expect(open).not.toHaveBeenCalled();
});
it("keeps Terminal available when a manual status check is only temporarily unavailable", async () => {
  const { client } = setup("claude");
  await act(async () => {});
  client.get.mockRejectedValue(new ProviderWorkflowClientError("unavailable"));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Continue in Terminal" })).toBeEnabled();
});

it.each(["stale-option", "expired", "forbidden"] as const)("preserves Main Claude Terminal continuation with %s receipt", async scenario => {
  const { client, operation, open } = setup("claude");
  await act(async () => {});
  if (scenario === "stale-option") client.get.mockResolvedValue({ ...operation, connectionOption: { ...operation.connectionOption, id: "stale_terminal" } });
  if (scenario === "forbidden") client.get.mockRejectedValue(new ProviderWorkflowClientError("forbidden"));
  await act(() => vi.advanceTimersByTimeAsync(scenario === "expired" ? 10000 : 2000));
  fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
  await act(async () => {});
  expect(open).toHaveBeenCalledExactlyOnceWith(operation.terminalSessionId);
});
