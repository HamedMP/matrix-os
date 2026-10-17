// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { managedConnectionCapability } from "../../packages/ui/src/agents-providers/managed-connection-capability";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../../packages/ui/src/agents-providers/types";

afterEach(cleanup);
const option = { id: "openai_terminal", providerId: "openai", authKind: "subscription", method: "terminal", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const capability: ProviderWorkflowUICapability = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false, connectionOptions: [option] };
function setup({ disabled = false, restored = false, advertised = capability, receiptOption = option }: { disabled?: boolean; restored?: boolean; advertised?: ProviderWorkflowUICapability; receiptOption?: ProviderWorkflowConnectionOption } = {}) {
  const operation = { id: "native-login", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_owner:tt_codex", deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: receiptOption } as const;
  const client = { capabilities: vi.fn(), start: vi.fn(), startConnection: vi.fn().mockResolvedValue(operation), get: vi.fn().mockResolvedValue(operation), cancel: vi.fn().mockResolvedValue({ ...operation, state: "cancelled" }), submitKey: vi.fn(), logs: vi.fn() } as unknown as ProviderWorkflowClient;
  const open = vi.fn();
  render(<HarnessWorkflowPanel harness={{ id: "codex", harness: "codex", displayName: "Codex", installState: "installed", authState: "unauthenticated" }} capability={advertised} client={client} disabled={disabled} onRefresh={vi.fn()} onOpenTerminal={open} operationId={restored ? operation.id : null} />);
  return { client, open };
}
it("starts only the exact native terminal option and cancels its continuation", async () => {
  const { client, open } = setup();
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Log in in Terminal/ }));
  await waitFor(() => expect(client.startConnection).toHaveBeenCalledWith(expect.objectContaining({ harnessInstanceId: "codex", optionId: "openai_terminal" }), expect.any(AbortSignal)));
  expect(open).toHaveBeenCalledWith("tws_owner:tt_codex");
  expect(client.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull());
});
it("reopens the exact retained native Terminal without starting new authorization", async () => {
  const { client, open } = setup({ restored: true });
  fireEvent.click(await screen.findByRole("button", { name: "Continue in Terminal" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("tws_owner:tt_codex"));
  expect(client.startConnection).not.toHaveBeenCalled();
});
it("does not start or continue login for read-only users", async () => {
  const { client, open } = setup({ disabled: true, restored: true });
  const button = await screen.findByRole("button", { name: "Continue in Terminal" });
  expect(button).toBeDisabled(); fireEvent.click(button);
  expect(open).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
});
it.each(["browser", "device_code", "existing_codex"] as const)("filters unsupported or legacy %s options even beside a current terminal option", method => {
  const filtered = managedConnectionCapability({ ...capability, loginMethods: [method, "terminal"], connectionOptions: [option, { ...option, id: method === "device_code" ? "legacy_device_code" : `openai_${method}`, method }] });
  expect(filtered.loginMethods).toEqual(["terminal"]);
  expect(filtered.connectionOptions).toEqual([option]);
});
it("retains the exact current native device-code option independently alongside Terminal", () => {
  const device = { ...option, id: "openai_device_code", method: "device_code" } as const;
  const filtered = managedConnectionCapability({ ...capability, loginMethods: ["device_code", "terminal"], connectionOptions: [device, option] });
  expect(filtered.loginMethods).toEqual(["device_code", "terminal"]);
  expect(filtered.connectionOptions).toEqual([device, option]);
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
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Log in in Terminal/ }));
  await waitFor(() => expect(client.startConnection).toHaveBeenCalled());
  await screen.findByRole("alert");
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).toBeNull();
});
