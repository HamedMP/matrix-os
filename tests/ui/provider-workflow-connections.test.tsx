// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../../packages/ui/src/agents-providers/types";
import { useHarnessWorkflowController } from "../../packages/ui/src/agents-providers/use-harness-workflow-controller";
import { keyFailureMessage } from "../../packages/ui/src/agents-providers/key-format.js";
import type { ProviderAccessSource, ProviderAccount, ProviderHarnessInstance } from "../../packages/contracts/src/index.js";
import { isNativeAccountSource } from "../../packages/ui/src/agents-providers/harness-connection.js";
import { resolvedWorkflowRowStatus } from "../../packages/ui/src/agents-providers/workflow-row-status.js";
afterEach(cleanup);
const options = [
  {id: "pi:openai:device", providerId: "openai", authKind: "subscription", method: "device_code", billingKind: "subscription", executionKind: "native", availability: "available"},
  {id: "pi:anthropic:key", providerId: "anthropic", authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "available"},
  {id: "pi:openrouter:key", providerId: "openrouter", authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "unavailable", unavailableReason: "unsupported_runtime"},
] as const;
const capability: ProviderWorkflowUICapability = {harnessInstanceId: "pi", harness: "pi", displayName: "Pi", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: false, connectionOptions: [...options]};
function setup() {
 const client = {capabilities: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn(), startConnection: vi.fn(), submitConnectionKey: vi.fn().mockResolvedValue({verified: true})} as unknown as ProviderWorkflowClient;
 render(<HarnessWorkflowPanel harness={{id: "pi", harness: "pi", displayName: "Pi", installState: "installed", authState: "unauthenticated"}} capability={capability} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
 return client;
}
it("chooses an exact provider/method before native key saving", async () => {
 const client = setup();
 expect(client.startConnection).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", {name: /Anthropic API key/}));
 fireEvent.change(screen.getByLabelText("Paste your Anthropic API key"), {target: {value: "synthetic-only-key"}});
 fireEvent.click(screen.getByRole("button", {name: "Connect"}));
 await waitFor(() => expect(client.submitConnectionKey).toHaveBeenCalledWith({harnessInstanceId: "pi", optionId: "pi:anthropic:key", apiKey: "synthetic-only-key"}, expect.any(AbortSignal)));
 expect(client.submitKey).not.toHaveBeenCalled();
});
it("explains a pasted Claude subscription token without sending it", async () => {
 const client = setup();
 fireEvent.click(screen.getByRole("button", {name: /Anthropic API key/}));
 fireEvent.change(screen.getByLabelText("Paste your Anthropic API key"), {target: {value: "  sk-ant-oat01-synthetic"}});
 fireEvent.click(screen.getByRole("button", {name: "Connect"}));
 expect(await screen.findByText(/subscription sign-in token, not an API key/)).toBeInTheDocument();
 expect(client.submitConnectionKey).not.toHaveBeenCalled();
 expect(client.submitKey).not.toHaveBeenCalled();
});
it("keeps unsupported runtime options unavailable with safe copy", () => {
 const client = setup();
 const unsupported = screen.getByRole("button", {name: /OpenRouter API key/});
 expect(unsupported).toBeDisabled();
 expect(screen.getByText(/requires a supported agent version/)).toBeInTheDocument();
 fireEvent.click(unsupported);
 expect(client.submitConnectionKey).not.toHaveBeenCalled();
});

it("starts the selected official Claude browser method with its exact identity", async () => {
 const option={...options[0],id:"claude:anthropic:browser",providerId:"anthropic" as const,method:"browser" as const};
 const client={capabilities:vi.fn(),start:vi.fn(),get:vi.fn(),cancel:vi.fn(),submitKey:vi.fn(),logs:vi.fn(),submitCode:vi.fn(),startConnection:vi.fn().mockResolvedValue({id:"connection",harnessInstanceId:"claude",kind:"login",state:"running",expiresAt:new Date(Date.now()+60000).toISOString(),terminalSessionId:null,deviceCode:null,authorizationUrl:null,safeFailure:null,connectionOption:option})} as unknown as ProviderWorkflowClient;
 render(<HarnessWorkflowPanel harness={{id:"claude",harness:"claude",displayName:"Claude Code",installState:"installed",authState:"unauthenticated"}} capability={{...capability,harnessInstanceId:"claude",harness:"claude",displayName:"Claude Code",loginMethods:["browser"],connectionOptions:[option]}} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()}/>);
 fireEvent.click(screen.getByRole("button",{name:/Claude account · Sign in in browser/}));
 await screen.findByText("Finish signing in to Claude");
 expect(client.startConnection).toHaveBeenCalledWith(expect.objectContaining({harnessInstanceId:"claude",optionId:option.id}),expect.any(AbortSignal));
 expect(client.start).not.toHaveBeenCalled();
});

it("offers qualified Terminal methods on the primary connection path", async () => {
 const terminalOption = {...options[0], id: "claude:anthropic:terminal", providerId: "anthropic" as const, method: "terminal" as const};
 const client = {capabilities: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn(), startConnection: vi.fn().mockResolvedValue({id: "terminal", harnessInstanceId: "claude", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_1:tt_1", deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: terminalOption})} as unknown as ProviderWorkflowClient;
 const openTerminal = vi.fn();
 render(<HarnessWorkflowPanel harness={{id: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", authState: "unauthenticated"}} capability={{...capability, harnessInstanceId:"claude", harness:"claude", displayName:"Claude Code", loginMethods: ["terminal"], apiKeyProviders: [], connectionOptions: [terminalOption]}} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={openTerminal} />);
 expect(screen.queryByText("Advanced configuration")).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", {name: /Claude account · Log in in Terminal/}));
 await waitFor(() => expect(openTerminal).toHaveBeenCalledWith("tws_1:tt_1"));
 expect(screen.getByRole("button", {name: "Continue in Terminal"})).toBeInTheDocument();
});

it("removes Terminal continuation after cancelling a qualified login", async () => {
 const option = {...options[0], id: "claude:anthropic:terminal", providerId: "anthropic" as const, method: "terminal" as const};
 const operation = {id: "cancel-terminal", harnessInstanceId: "claude", kind: "login" as const, state: "running" as const, expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_1:tt_1", deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: option};
 const client = {capabilities: vi.fn(), start: vi.fn(), get: vi.fn().mockResolvedValue(operation), cancel: vi.fn().mockResolvedValue({...operation, state: "cancelled"}), submitKey: vi.fn(), logs: vi.fn(), startConnection: vi.fn().mockResolvedValue(operation)} as unknown as ProviderWorkflowClient;
 const refresh = vi.fn(); const open = vi.fn();
 render(<HarnessWorkflowPanel harness={{id: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", authState: "unauthenticated"}} capability={{...capability, harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", loginMethods: ["terminal"], apiKeyProviders: [], connectionOptions: [option]}} client={client} disabled={false} onRefresh={refresh} onOpenTerminal={open} />);
 fireEvent.click(screen.getByRole("button", {name: /Claude account · Log in in Terminal/}));
 await waitFor(() => expect(open).toHaveBeenCalledWith("tws_1:tt_1"));
 expect(screen.getByRole("button", {name: "Continue in Terminal"})).toBeEnabled();
 fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
 await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
 expect(screen.queryByRole("button", {name: "Continue in Terminal"})).not.toBeInTheDocument();
 expect(screen.queryByRole("button", {name: "Cancel"})).not.toBeInTheDocument();
 expect(screen.getByRole("button", {name: /Claude account · Log in in Terminal/})).toBeEnabled();
 expect(client.cancel).toHaveBeenCalledWith("cancel-terminal", expect.any(AbortSignal));
 expect(open).toHaveBeenCalledOnce();
});

it.each(["install", "uninstall"] as const)("retains settled %s Terminal diagnostics", async kind => {
 const client = {get: vi.fn().mockResolvedValue({id: "diagnostic", harnessInstanceId: "pi", kind, state: "failed", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_1:tt_1", deviceCode: null, authorizationUrl: null, safeFailure: "unavailable"}), start: vi.fn(), cancel: vi.fn(), logs: vi.fn()} as unknown as ProviderWorkflowClient;
 const open = vi.fn();
 render(<HarnessWorkflowPanel harness={{id: "pi", harness: "pi", displayName: "Pi", installState: "installed", authState: "unauthenticated"}} capability={capability} client={client} operationId="diagnostic" disabled={false} onRefresh={vi.fn()} onOpenTerminal={open} />);
 fireEvent.click(await screen.findByRole("button", {name: "Continue in Terminal"}));
 await waitFor(() => expect(open).toHaveBeenCalledWith("tws_1:tt_1"));
 expect(client.start).not.toHaveBeenCalled();
});

it("keeps valid connected native authorization without opening another login", () => {
 const client = {capabilities: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn(), startConnection: vi.fn(), submitConnectionKey: vi.fn()} as unknown as ProviderWorkflowClient;
 render(<HarnessWorkflowPanel harness={{id: "pi", harness: "pi", displayName: "Pi", installState: "installed", authState: "authenticated"}} capability={capability} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} renderConnection={action => <article>Connected on this computer{action}</article>} />);
 expect(screen.getByText("Connected on this computer")).toBeInTheDocument();
 expect(screen.queryByRole("button", {name: /ChatGPT account/})).not.toBeInTheDocument();
 expect(client.startConnection).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", {name: "Change account"}));
 expect(screen.getByRole("button", {name: /Anthropic API key/})).toBeEnabled();
 expect(client.startConnection).not.toHaveBeenCalled();
});

it("fences a transient key submission when the selected native account changes", async () => {
 let settle!: () => void;
 const client = {capabilities: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn(), startConnection: vi.fn(), submitConnectionKey: vi.fn(() => new Promise<{verified:true}>(resolve => {settle = () => resolve({verified:true});}))} as unknown as ProviderWorkflowClient;
 const refresh = vi.fn();
 const props = {capability, client, disabled: false, onRefresh: refresh, onOpenTerminal: vi.fn()};
 const harness = {id:"pi", harness:"pi" as const, displayName:"Pi", installState:"installed" as const, authState:"unauthenticated" as const, selectedAccountId:"account_a"};
 const view = render(<HarnessWorkflowPanel {...props} harness={harness} />);
 fireEvent.click(screen.getByRole("button", {name:/Anthropic API key/}));
 fireEvent.change(screen.getByLabelText("Paste your Anthropic API key"), {target:{value:"synthetic-account-a-key"}});
 fireEvent.click(screen.getByRole("button", {name:"Connect"}));
 const signal = vi.mocked(client.submitConnectionKey!).mock.calls[0][1];
 view.rerender(<HarnessWorkflowPanel {...props} harness={{...harness, selectedAccountId:"account_b"}} />);
 expect(signal.aborted).toBe(true);
 expect(screen.queryByLabelText("Paste your Anthropic API key")).not.toBeInTheDocument();
 settle();
 await Promise.resolve();
 expect(refresh).not.toHaveBeenCalled();
});

it("discards an outstanding receipt read after the selected account changes", async () => {
 const remember = vi.fn();
 let settle!: (value: unknown) => void;
 const client = {get: vi.fn(() => new Promise(resolve => { settle = resolve; }))} as unknown as ProviderWorkflowClient;
 const harness = {id:"pi", harness:"pi" as const, displayName:"Pi", installState:"installed" as const, authState:"unauthenticated" as const, selectedAccountId:"account_a"};
 const refresh = vi.fn();
 const {result, rerender} = renderHook(({account}) => useHarnessWorkflowController({
   harness:{...harness, selectedAccountId:account}, capability, client, disabled:false,
   onRefresh:refresh, onOpenTerminal:vi.fn(), onOperationId:remember, operationId:"restored_a",
 }), {initialProps:{account:"account_a"}});
 const oldSignal = vi.mocked(client.get).mock.calls[0][1];
 const oldSettle = settle;
 rerender({account:"account_b"});
 await act(async () => oldSettle({id:"restored_a", harnessInstanceId:"pi", kind:"login", state:"succeeded",
   expiresAt:new Date(Date.now()+60000).toISOString(), terminalSessionId:null, deviceCode:null, authorizationUrl:null,
   safeFailure:null, connectionOption:options[0]}));
 expect(oldSignal.aborted).toBe(true);
 expect(client.get).toHaveBeenCalledOnce();
 expect(remember).toHaveBeenCalledWith(null);
 expect(result.current.operation).toBeNull();
 expect(refresh).not.toHaveBeenCalled();
});

// API key failure wording shared by Settings and onboarding.
{
describe("API key failure wording", () => {
  it("names the provider and the fix for a refused key", () => {
    expect(keyFailureMessage("rejected", "anthropic")).toBe("Anthropic didn't accept this key. Check that you copied all of it, or create a new key in your Anthropic account.");
    expect(keyFailureMessage("rejected", "openai")).toBe("OpenAI didn't accept this key. Check that you copied all of it, or create a new key in your OpenAI account.");
    expect(keyFailureMessage("rejected", "anthropic", "short")).toBe("Anthropic didn't accept this key");
  });

  it("says how to fix a key outside any workspace", () => {
    expect(keyFailureMessage("key_workspace_required", "anthropic")).toBe("This key isn't in a workspace. In the Anthropic Console, create a key inside a workspace, then paste it here.");
    expect(keyFailureMessage("key_workspace_required", "anthropic", "short")).toBe("This key isn't in a workspace");
  });

  it("keeps an uncertain failure from blaming the key", () => {
    expect(keyFailureMessage("unavailable", "anthropic")).toBe("Could not confirm the connection. Check its status before trying again.");
    expect(keyFailureMessage("unavailable", "anthropic", "short")).toBe("Couldn't connect right now. Try again.");
  });
});
}

// Settings status for fixed Claude on the owner Anthropic key.
{
const readiness = { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" } as ProviderAccessSource["readiness"];
const keySource = { id: "owner_anthropic_key", kind: "provider_account", providerId: "anthropic", accountId: "owner_anthropic",
  fundingKind: "owner_api_key", displayName: "Anthropic API key", eligibleModelIds: ["claude-sonnet-5"], readiness } as unknown as ProviderAccessSource;
const keyAccount = { id: "owner_anthropic", providerId: "anthropic", accessSourceId: "owner_anthropic_key", authMethod: "api_key", authState: "authenticated" } as unknown as ProviderAccount;
const claude = { id: "harness_claude_code", harness: "claude", installState: "installed", authState: "authenticated", enabled: true, configuredEnabled: true,
  accessSourceId: "owner_anthropic_key", selectedAccountId: "owner_anthropic", route: { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" } } as unknown as ProviderHarnessInstance;

describe("Settings status for Claude on the owner's Anthropic key", () => {
  it("treats the selected owner key as Claude's own connection and shows it as Connected", () => {
    expect(isNativeAccountSource("claude", keySource, keyAccount)).toBe(true);
    expect(resolvedWorkflowRowStatus(claude, keySource)).toBe("Connected");
  });

  it("is Not connected once the gateway no longer reports the key as signed in", () => {
    expect(resolvedWorkflowRowStatus({ ...claude, authState: "unknown" }, keySource)).toBe("Not connected");
  });

  it("never treats a Matrix AI gateway source as Claude's own connection", () => {
    const matrix = { ...keySource, id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included", accountId: null } as unknown as ProviderAccessSource;
    expect(isNativeAccountSource("claude", matrix, undefined)).toBe(false);
  });
});
}
