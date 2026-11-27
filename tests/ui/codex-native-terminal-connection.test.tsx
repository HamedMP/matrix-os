// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderAccessSource, ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { managedConnectionCapability } from "../../packages/ui/src/agents-providers/managed-connection-capability";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../../packages/ui/src/agents-providers/types";

afterEach(cleanup);
const option = { id: "openai_terminal", providerId: "openai", authKind: "subscription", method: "terminal", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const device = { ...option, id: "openai_device_code", method: "device_code" } as const;
const existing = { ...option, id: "openai_existing_codex", method: "existing_codex" } as const;
const capability: ProviderWorkflowUICapability = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false, connectionOptions: [option] };
const savedSource: ProviderAccessSource = {
  id: "owner_openai_profile", kind: "provider_account", fundingKind: "owner_account", providerId: "openai",
  accountId: "owner_codex", displayName: "Codex account", eligibleModelIds: [],
  readiness: { state: "auth_required", checkedAt: null, staleAfter: null, action: "open_terminal", safeReason: "auth" },
  usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "account", reason: "not_authenticated", asOf: null },
};
function setup({ disabled = false, restored = false, advertised = capability, receiptOption = option, state = "running", terminalAvailable = true, saved = false }: { disabled?: boolean; restored?: boolean; advertised?: ProviderWorkflowUICapability; receiptOption?: ProviderWorkflowConnectionOption; state?: "running" | "succeeded" | "failed"; terminalAvailable?: boolean; saved?: boolean } = {}) {
  const operation = { id: "native-login", harnessInstanceId: "codex", kind: "login", state, expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_owner:tt_codex", deviceCode: receiptOption.method === "device_code" ? "ABCD-EFGHI" : null, authorizationUrl: receiptOption.method === "device_code" ? "https://auth.openai.com/codex/device" : null, safeFailure: state === "failed" ? "unavailable" : null, connectionOption: receiptOption } as const;
  const client = { capabilities: vi.fn(), start: vi.fn(), startConnection: vi.fn().mockResolvedValue(operation), get: vi.fn().mockResolvedValue(operation), cancel: vi.fn().mockResolvedValue({ ...operation, state: "cancelled" }), submitKey: vi.fn(), logs: vi.fn() } as unknown as ProviderWorkflowClient;
  const open = vi.fn();
  const refreshConnection = vi.fn(async () => {});
  const connectSaved = vi.fn(async () => {});
  const onRefresh = vi.fn();
  const panel = (currentCapability: ProviderWorkflowUICapability) => <HarnessWorkflowPanel
    harness={{ id: "codex", harness: "codex", displayName: "Codex", installState: "installed", authState: saved ? "expired" : "unauthenticated" }}
    source={saved ? savedSource : undefined} capability={currentCapability} client={client} disabled={disabled}
    onRefresh={onRefresh} onRefreshAfterLogin={refreshConnection} onOpenTerminal={open} onConnectSaved={saved ? connectSaved : undefined}
    operationId={restored ? operation.id : null} terminalAvailable={terminalAvailable} />;
  const view = render(panel(advertised));
  return { client, open, refreshConnection, refreshCapability: (next: ProviderWorkflowUICapability) => view.rerender(panel(next)) };
}
it("starts only the exact native terminal option and cancels its continuation", async () => {
  const { client, open } = setup();
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Sign in with Codex CLI/ }));
  const continueInTerminal = await screen.findByRole("button", { name: "Continue in Terminal" });
  expect(client.startConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harnessInstanceId: "codex", optionId: "openai_terminal" }), expect.any(AbortSignal));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole("status", { name: "Checking Codex connection" })).toBeVisible();
  expect(screen.queryByText(/Code expires/)).not.toBeInTheDocument();
  expect(client.start).not.toHaveBeenCalled();
  fireEvent.click(continueInTerminal);
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("tws_owner:tt_codex"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull());
});
it.each(["succeeded", "failed"] as const)("keeps an immediately %s Terminal workflow in Settings", async state => {
  const { client, open, refreshConnection } = setup({ state });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Sign in with Codex CLI/ })));
  expect(client.startConnection).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).not.toBeInTheDocument();
  if (state === "succeeded") {
    expect(refreshConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "native-login", state: "succeeded" }));
  } else {
    expect(refreshConnection).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't connect.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  }
});
it("reopens the exact retained native Terminal without starting new authorization", async () => {
  const { client, open } = setup({ restored: true });
  fireEvent.click(await screen.findByRole("button", { name: "Continue in Terminal" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("tws_owner:tt_codex"));
  expect(client.startConnection).not.toHaveBeenCalled();
});
it.each([option, device])("restores and cancels an already active $method login when reuse becomes available", async receiptOption => {
  const advertised: ProviderWorkflowUICapability = { ...capability, loginMethods: ["terminal", "device_code", "existing_codex"], connectionOptions: [option, device, existing] };
  const { client, open } = setup({ restored: true, advertised, receiptOption });
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  expect(screen.getByRole("button", { name: /^Use existing Codex account/ })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /Sign in with a code|Sign in with Codex CLI/ })).not.toBeInTheDocument();
  if (receiptOption === option) {
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" })));
    expect(open).toHaveBeenCalledExactlyOnceWith("tws_owner:tt_codex");
  } else {
    expect(screen.getByText("ABCD-EFGHI")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue in Terminal" })).not.toBeInTheDocument();
  }
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
  expect(client.cancel).toHaveBeenCalledExactlyOnceWith("native-login", expect.any(AbortSignal));
  expect(client.startConnection).not.toHaveBeenCalled();
});
it("offers device-code recovery alone when the surface cannot open Terminal", async () => {
  const advertised: ProviderWorkflowUICapability = { ...capability, loginMethods: ["terminal", "device_code", "existing_codex"], connectionOptions: [option, device, existing] };
  const { client } = setup({ advertised, receiptOption: existing, state: "failed", terminalAvailable: false });
  fireEvent.click(screen.getByRole("button", { name: /^Use existing Codex account/ }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: /Sign in with a code/ })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Sign in with Codex CLI/ })).not.toBeInTheDocument();
  expect(client.startConnection).toHaveBeenCalledOnce();
});
it.each([true, false])("keeps saved verification recovery explicit when the reuse option disappears (device available: %s)", async deviceAvailable => {
  const advertised: ProviderWorkflowUICapability = { ...capability, loginMethods: ["terminal", "device_code", "existing_codex"], connectionOptions: [option, device, existing] };
  const { client, open, refreshCapability } = setup({ advertised, receiptOption: existing, state: "failed", terminalAvailable: false, saved: true });
  fireEvent.click(screen.getByRole("button", { name: "Use existing Codex account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify the existing Codex account");
  refreshCapability(deviceAvailable ? { ...capability, loginMethods: ["terminal", "device_code"], connectionOptions: [option, device] } : capability);

  expect(screen.queryByRole("button", { name: /^Reconnect$/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Sign in with Codex CLI/ })).not.toBeInTheDocument();
  if (deviceAvailable) expect(screen.getByRole("button", { name: /Sign in with a code/ })).toBeEnabled();
  expect(client.startConnection).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});
it("still reports a restored CLI attempt on a surface without Terminal", async () => {
  const { client, open } = setup({ restored: true, terminalAvailable: false });
  expect(await screen.findByRole("status", { name: "Checking Codex connection" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).not.toBeInTheDocument();
  expect(client.startConnection).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
it("does not start or continue login for read-only users", async () => {
  const { client, open } = setup({ disabled: true, restored: true });
  const button = await screen.findByRole("button", { name: "Continue in Terminal" });
  expect(button).toBeDisabled(); fireEvent.click(button);
  expect(open).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
});
it.each(["browser", "device_code", "existing_codex"] as const)("filters unsupported or legacy %s options even beside a current terminal option", method => {
  const filtered = managedConnectionCapability({ ...capability, loginMethods: [method, "terminal"], connectionOptions: [option, { ...option, id: `legacy_${method}`, method }] });
  expect(filtered.loginMethods).toEqual(["terminal"]);
  expect(filtered.connectionOptions).toEqual([option]);
});
it("retains exact existing-account, device-code and Terminal options independently", () => {
  const filtered = managedConnectionCapability({ ...capability, loginMethods: ["device_code", "terminal", "existing_codex"], connectionOptions: [device, option, existing] });
  expect(filtered.loginMethods).toEqual(expect.arrayContaining(["device_code", "terminal", "existing_codex"]));
  expect(filtered.loginMethods).toHaveLength(3);
  expect(filtered.connectionOptions).toEqual([device, option, existing]);
});
it.each([
  { loginMethods: ["terminal" as const] },
  { installState: "missing" as const },
  { connectionOptions: [{ ...existing, providerId: "anthropic" as const }] },
  { connectionOptions: [{ ...existing, billingKind: "api_key" as const }] },
  { connectionOptions: [{ ...existing, availability: "unavailable" as const, unavailableReason: "unsupported_runtime" as const }] },
])("never offers existing-account reuse from incomplete, unrelated or unavailable capability (%j)", patch => {
  const filtered = managedConnectionCapability({ ...capability, loginMethods: ["existing_codex"], connectionOptions: [existing], ...patch });
  expect(filtered.loginMethods).not.toContain("existing_codex");
  expect(filtered.connectionOptions?.some(candidate => candidate.method === "existing_codex")).toBe(false);
});
it.each([
  { connectionOptions: undefined },
  { connectionOptions: [{ ...option, id: "legacy_terminal" }] },
  { connectionOptions: [{ ...option, providerId: "anthropic" as const }] },
  { connectionOptions: [{ ...option, billingKind: "api_key" as const }] },
  { connectionOptions: [{ ...option, availability: "unavailable" as const, unavailableReason: "unsupported_runtime" as const }] },
])("never infers subscription capability from an installed CLI or legacy methods (%j)", patch => {
  const filtered = managedConnectionCapability({ ...capability, ...patch });
  expect(filtered.loginMethods).toEqual([]);
  expect(filtered.connectionOptions?.filter(item => item.authKind === "subscription" && item.availability === "available") ?? []).toEqual([]);
});
it("does not reopen a stale receipt when current capability is absent", async () => {
  const { client, open } = setup({ restored: true, advertised: { ...capability, connectionOptions: [] } });
  await waitFor(() => expect(client.get).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it("rejects a mismatched embedded login receipt before opening Terminal", async () => {
  const { client, open } = setup({ receiptOption: { ...option, method: "device_code" } });
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Sign in with Codex CLI/ }));
  await waitFor(() => expect(client.startConnection).toHaveBeenCalled());
  await screen.findByRole("alert");
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
});
