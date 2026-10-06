// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../../packages/ui/src/agents-providers/types";
import { useHarnessWorkflowController } from "../../packages/ui/src/agents-providers/use-harness-workflow-controller";
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
