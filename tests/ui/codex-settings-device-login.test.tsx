// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { createProviderWorkflowClient } from "../../packages/ui/src/agents-providers/provider-workflow-client";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const device = { id: "openai_device_code", providerId: "openai", authKind: "subscription", method: "device_code", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const terminal = { ...device, id: "openai_terminal", method: "terminal" } as const;
it("does not offer alternate connection methods on an already connected Codex profile", async () => {
  const request = vi.fn(async () => { throw new Error("No account operation from opening options"); });
  render(<HarnessWorkflowPanel harness={{ id: "harness_codex", harness: "codex", displayName: "Codex", installState: "installed", authState: "authenticated" }}
    capability={{ harnessInstanceId: "harness_codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code", "terminal"], connectionOptions: [device, terminal], apiKeyProviders: [], install: false, uninstall: false, logs: false }}
    client={createProviderWorkflowClient(request)} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} renderConnection={action => <div>{action}</div>} />);
  expect(screen.queryByRole("button", { name: "Change account" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connection options" })).toBeNull();
  expect(screen.queryByRole("button", { name: /ChatGPT account.*Sign in with a code/ })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it("shows the qualified official code in Settings and naturally settles after public workflow-client completion without opening Terminal", async () => {
  vi.useFakeTimers();
  const operation = { id: "workflow_fixture", harnessInstanceId: "harness_codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), authorizationUrl: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGHI", terminalSessionId: null, safeFailure: null, connectionOption: device } as const;
  let complete = false;
  const request = vi.fn(async ({ method }: { method: string }) => method === "POST" ? operation : complete ? { ...operation, state: "succeeded", authorizationUrl: null, deviceCode: null } : operation);
  const client = createProviderWorkflowClient(request), openTerminal = vi.fn(), openBrowser = vi.fn(), refresh = vi.fn(async () => {});
  render(<HarnessWorkflowPanel harness={{ id: "harness_codex", harness: "codex", displayName: "Codex", installState: "installed", authState: "unauthenticated" }}
    capability={{ harnessInstanceId: "harness_codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code", "terminal"], connectionOptions: [device, terminal], apiKeyProviders: [], install: false, uninstall: false, logs: false }}
    client={client} disabled={false} onRefresh={refresh} onRefreshAfterLogin={refresh} onOpenTerminal={openTerminal} onOpenAuthorizationUrl={openBrowser} />);
  const connect = screen.getByRole("button", { name: /ChatGPT account.*Sign in with a code/ });
  fireEvent.click(connect); await act(async () => {});
  expect(screen.getByText("ABCD-EFGHI")).toBeVisible();
  expect(screen.getByRole("status", { name: "Waiting for sign-in" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open sign-in page" })); await act(async () => {});
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://auth.openai.com/codex/device");
  complete = true; await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByText("ABCD-EFGHI")).toBeNull();
  expect(screen.queryByRole("status", { name: "Waiting for sign-in" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(openTerminal).not.toHaveBeenCalled();
  expect(request.mock.calls[0][0]).toMatchObject({ path: "/api/ai/provider-settings/workflows/v2/start", body: { optionId: "openai_device_code", harnessInstanceId: "harness_codex" } });
});
