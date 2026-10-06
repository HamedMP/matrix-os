// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../../packages/ui/src/agents-providers/types";
afterEach(cleanup);
function setup(overrides: Partial<ProviderWorkflowUICapability> = {}) {
 const option = {id:"codex:openai:terminal", providerId:"openai", authKind:"subscription", method:"terminal", billingKind:"subscription", executionKind:"native", availability:"available"} as const;
 const capability: ProviderWorkflowUICapability = {harnessInstanceId:"codex", harness:"codex", displayName:"Codex", installState:"installed", loginMethods:["terminal"], install:false, uninstall:false, logs:false, connectionOptions:[option, {id:"codex:openai:key", providerId:"openai",authKind:"api_key",billingKind:"api_key",executionKind:"native",availability:"available"}], apiKeyProviders:["openai"], ...overrides};
 const snapshot = {harnesses:[{id:"codex",harness:"codex",displayName:"Codex",installState:capability.installState,authState:"unauthenticated",connectivity:"online",enabled:true,configuredEnabled:true,accessSourceId:null,accountIds:[],selectedAccountId:null,loginMethods:["terminal"],route:{kind:"fixed",providerId:"openai",modelId:"selected-in-codex"}}], accounts:[],accessSources:[],modelProviders:[],gatewayPolicy:null,configurationHarnessKinds:[],supportedActions:[],access:{mode:"writable"},refreshedAt:"2026-10-06T00:00:00Z"} as unknown as ProviderSettingsSnapshot;
 const receipt = {id:"login",harnessInstanceId:"codex",kind:"login",state:"running",expiresAt:new Date(Date.now()+60000).toISOString(),terminalSessionId:"tws_1:tt_1",deviceCode:null,authorizationUrl:null,safeFailure:null,connectionOption:option};
 const client = {capabilities:vi.fn().mockResolvedValue([capability]),start:vi.fn().mockResolvedValue({...receipt, connectionOption:undefined}),startConnection:vi.fn().mockResolvedValue(receipt),get:vi.fn().mockResolvedValue(receipt),cancel:vi.fn(),submitKey:vi.fn(),submitConnectionKey:vi.fn().mockResolvedValue({verified:true}),logs:vi.fn()} as unknown as ProviderWorkflowClient;
 const props = {snapshot,selectedHarnessId:"codex",onSelectHarness:vi.fn(),onMutate:vi.fn(),onRefresh:vi.fn(),onOpenTerminal:vi.fn(),onOpenBrowser:vi.fn(),onAddCredit:vi.fn(),workflowClient:client};
 return {props, client, capability};
}
it("connects Codex with a qualified API key and omits stale subscription choices", async () => {
 const {props,client} = setup(); render(<AgentsProvidersView {...props}/>);
 const subscriptions = await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Connect Codex"}));
 expect(screen.getByRole("heading",{name:"Connect Codex with"})).toBeVisible();
 expect(screen.getByRole("button",{name:/^Codex.*Not connected/})).toHaveFocus();
 expect(screen.queryByRole("button",{name:/ChatGPT account/})).toBeNull();
 expect(screen.getByText(/Codex subscription connections are not currently supported/)).toBeVisible();
 expect(within(subscriptions).getByText(/OpenAI API key.*billed per request/)).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:/OpenAI API key/}));
 fireEvent.change(screen.getByLabelText("Paste your OpenAI API key"),{target:{value:"synthetic-key-only"}});
 fireEvent.click(screen.getByRole("button",{name:"Connect"}));
 await waitFor(()=>expect(client.submitConnectionKey).toHaveBeenCalledWith({harnessInstanceId:"codex",optionId:"codex:openai:key",apiKey:"synthetic-key-only"},expect.any(AbortSignal)));
 expect(client.startConnection).not.toHaveBeenCalled();
 expect(client.start).not.toHaveBeenCalled();
});
it("reuses the exact connected native account instead of repeating authorization", async () => {
 const {props,client} = setup(); Object.assign(props.snapshot.harnesses[0]!,{authState:"authenticated",accessSourceId:"native",selectedAccountId:"owner",accountIds:["owner"]});
 props.snapshot.accounts=[{id:"owner",accessSourceId:"native",displayName:"Current owner",authMethod:"terminal",authState:"authenticated",dependencies:{activeChatCount:0,resumableChatCount:0,harnessInstanceCount:1}}] as never;
 props.snapshot.accessSources=[{id:"native",kind:"provider_account",fundingKind:"owner_subscription",providerId:"openai",accountId:"owner",displayName:"ChatGPT subscription",eligibleModelIds:[],readiness:{state:"ready"},usage:{kind:"unavailable",reason:"unknown"}}] as never;
 render(<AgentsProvidersView {...props}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Manage Codex connection"}));
 expect(within(subscriptions).getByText("Saved account")).toBeInTheDocument();
 expect(within(subscriptions).getByText("Current owner")).toBeInTheDocument();
 expect(within(subscriptions).getByText(/Codex subscription connections are not currently supported/)).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:/ChatGPT account ·/})).not.toBeInTheDocument();
 expect(client.startConnection).not.toHaveBeenCalled();
});
it("opens real installation when available and never fabricates an unavailable Claude flow", async () => {
 const {props,client}=setup({installState:"missing",install:true}); render(<AgentsProvidersView {...props}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Install Codex"}));
 expect(screen.getByRole("button",{name:"Install"})).toBeEnabled();
 expect(client.start).not.toHaveBeenCalled();
 expect(within(subscriptions).queryByRole("button",{name:"Connect Claude"})).not.toBeInTheDocument();
 expect(within(subscriptions).getByText(/Claude Code connection is unavailable/)).toBeInTheDocument();
});
it("preserves legacy Codex key entry while suppressing old subscription methods", async () => {
 const {props,client}=setup({connectionOptions:undefined,loginMethods:["device_code","terminal"]}); render(<AgentsProvidersView {...props}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Connect Codex"}));
 expect(screen.queryByRole("button",{name:/ChatGPT account/})).toBeNull();
 expect(screen.queryByRole("button",{name:"Log in in Terminal"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/^API key/}));
 expect(screen.getByLabelText("Paste your OpenAI API key")).toBeVisible();
 expect(client.start).not.toHaveBeenCalled();
});
it("clears a prior Computer's shortcut operation and fences late capability discovery", async () => {
 const {props,client}=setup({activeOperationId:"login"}); const view=render(<AgentsProvidersView {...props}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Review Codex connection"}));
 await waitFor(()=>expect(client.get).toHaveBeenCalled());
 const replacement={...client,capabilities:vi.fn().mockResolvedValue([]),get:vi.fn()} as ProviderWorkflowClient;
 await act(async()=>view.rerender(<AgentsProvidersView {...props} snapshot={{...props.snapshot,harnesses:[]}} workflowClient={replacement}/>));
 expect(within(screen.getByRole("region",{name:"Your subscriptions"})).queryByRole("button",{name:"Review Codex connection"})).not.toBeInTheDocument();
 expect(replacement.get).not.toHaveBeenCalled();
});
it("opens Claude's advertised official browser flow separately from Codex and Bot consent", async () => {
 const {props,client,capability}=setup();
 const option={id:"claude:anthropic:browser",providerId:"anthropic",authKind:"subscription",method:"browser",billingKind:"subscription",executionKind:"native",availability:"available"} as const;
 props.snapshot.harnesses.push({...props.snapshot.harnesses[0]!,id:"claude",harness:"claude",displayName:"Claude Code",route:{kind:"fixed",providerId:"anthropic",modelId:"native"}});
 vi.mocked(client.capabilities).mockResolvedValue([capability,{...capability,harnessInstanceId:"claude",harness:"claude",displayName:"Claude Code",loginMethods:["browser"],connectionOptions:[option]}]);
 client.submitCode=vi.fn();
 vi.mocked(client.startConnection!).mockResolvedValue({id:"claude_login",harnessInstanceId:"claude",kind:"login",state:"running",expiresAt:new Date(Date.now()+60000).toISOString(),terminalSessionId:null,deviceCode:null,authorizationUrl:null,safeFailure:null,connectionOption:option});
 render(<AgentsProvidersView {...props}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Connect Claude"}));
 fireEvent.click(screen.getByRole("button",{name:/Claude account · Sign in in browser/}));
 await waitFor(()=>expect(client.startConnection).toHaveBeenCalledWith(expect.objectContaining({harnessInstanceId:"claude",optionId:option.id}),expect.any(AbortSignal)));
 expect(props.onSelectHarness).toHaveBeenCalledWith("claude");
});
it("does not promise excluded Matrix ChatGPT consent or offer read-only subscription login", async () => {
 const {props,client}=setup(); props.snapshot.access={mode:"read_only",reason:"remote_policy"};
 client.botConnections={connections:vi.fn(),authorizeConnection:vi.fn(),execution:vi.fn(),configureExecution:vi.fn()};
 render(<AgentsProvidersView {...props}/>);
 await waitFor(()=>expect(client.capabilities).toHaveBeenCalled());
 const subscriptions=screen.getByRole("region",{name:"Your subscriptions"});
 expect(within(subscriptions).queryByRole("button",{name:"Connect Codex"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/^Codex/}));
 expect(screen.queryByText("Use for Bots")).toBeNull();
 expect(client.botConnections.connections).not.toHaveBeenCalled();
});
it("rejects late previous-Computer capabilities rather than reintroducing Connect", async () => {
 const {props,client,capability}=setup(); let settle!: (value: ProviderWorkflowUICapability[])=>void;
 vi.mocked(client.capabilities).mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
 const view=render(<AgentsProvidersView {...props}/>);
 const oldSignal=vi.mocked(client.capabilities).mock.calls[0][0];
 const next={...client,capabilities:vi.fn().mockResolvedValue([])};
 await act(async()=>view.rerender(<AgentsProvidersView {...props} snapshot={{...props.snapshot,harnesses:[]}} workflowClient={next}/>));
 await act(async()=>settle([capability]));
 expect(oldSignal?.aborted).toBe(true);
 expect(within(screen.getByRole("region",{name:"Your subscriptions"})).queryByRole("button",{name:"Connect Codex"})).toBeNull();
});
it("does not offer a Codex Terminal subscription workaround or a dead Connect button", async () => {
 const {props,client}=setup({connectionOptions:undefined,loginMethods:["terminal"],apiKeyProviders:[]}); render(<AgentsProvidersView {...props}/>);
 await waitFor(()=>expect(client.capabilities).toHaveBeenCalled());
 const subscriptions=screen.getByRole("region",{name:"Your subscriptions"});
 expect(within(subscriptions).queryByRole("button",{name:"Connect Codex"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/^Codex/}));
 expect(screen.queryByRole("button",{name:"Log in in Terminal"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Reconnect"})).toBeNull();
 expect(client.start).not.toHaveBeenCalled();
});
it("keeps saved Codex metadata without promising unavailable account changes", async () => {
 const {props,client}=setup({connectionOptions:[],apiKeyProviders:[]});
 Object.assign(props.snapshot.harnesses[0]!,{authState:"authenticated",accessSourceId:"native",accountIds:["owner"],selectedAccountId:"owner"});
 props.snapshot.accounts=[{id:"owner",accessSourceId:"native",displayName:"Recorded owner",authState:"authenticated",authMethod:"terminal",dependencies:{activeChatCount:0,resumableChatCount:0,harnessInstanceCount:1}}] as never;
 props.snapshot.accessSources=[{id:"native",kind:"provider_account",fundingKind:"owner_subscription",providerId:"openai",accountId:"owner",displayName:"Recorded account",eligibleModelIds:[],readiness:{state:"ready"},usage:{kind:"unavailable",reason:"unknown"}}] as never;
 render(<AgentsProvidersView {...props}/>); await waitFor(()=>expect(client.capabilities).toHaveBeenCalled());
 const subscriptions=screen.getByRole("region",{name:"Your subscriptions"});
 expect(within(subscriptions).getByText("Recorded owner")).toBeVisible();
 expect(within(subscriptions).queryByRole("button",{name:"Manage Codex connection"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/^Codex/}));
 expect(screen.queryByRole("button",{name:"Change account"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Reconnect"})).toBeNull();
 expect(client.startConnection).not.toHaveBeenCalled();
});
it("omits the legacy generic Terminal auth shortcut while keeping supported key entry", async () => {
 const {props,client}=setup({harnessInstanceId:"pi",harness:"pi",displayName:"Pi",connectionOptions:[],loginMethods:[],apiKeyProviders:[]});
 Object.assign(props.snapshot.harnesses[0]!,{id:"pi",harness:"pi",displayName:"Pi",loginMethods:[]});
 props.snapshot.harnessCatalog=[{harness:"pi",displayName:"Pi",installState:"installed",available:true,runnable:true,setupAction:"open_terminal",safeReason:null}];
 vi.mocked(client.capabilities).mockResolvedValue([]);
 const onSetupHarness=vi.fn(); render(<AgentsProvidersView {...props} onSetupHarness={onSetupHarness}/>);
 await act(async()=>{}); fireEvent.click(screen.getByRole("button",{name:/^Pi/}));
 expect(screen.queryByText("Connect in Terminal")).toBeNull();
 expect(onSetupHarness).not.toHaveBeenCalled();
});

it.each([false, true])("does not present legacy Matrix-funded Claude as a native subscription (enabled=%s)", async enabled => {
 const {props,client,capability}=setup();
 Object.assign(props.snapshot.harnesses[0]!,{id:"claude",harness:"claude",displayName:"Claude Code",authState:"authenticated",enabled,configuredEnabled:enabled,accessSourceId:"matrix_credit",accountIds:["funded"],selectedAccountId:"funded",route:{kind:"fixed",providerId:"anthropic",modelId:"native"}});
 props.snapshot.accounts=[{id:"funded",accessSourceId:"matrix_credit",displayName:"Matrix AI",authMethod:"terminal",authState:"authenticated",dependencies:{activeChatCount:0,resumableChatCount:0,harnessInstanceCount:1}}] as never;
 props.snapshot.accessSources=[{id:"matrix_credit",kind:"matrix_gateway",fundingKind:"matrix_included",providerId:"anthropic",accountId:null,displayName:"Matrix AI",eligibleModelIds:[],readiness:{state:"ready"},usage:{kind:"unavailable",reason:"unknown"}}] as never;
 props.snapshot.supportedActions=["set_harness_enabled"];
 vi.mocked(client.capabilities).mockResolvedValue([{...capability,harnessInstanceId:"claude",harness:"claude",displayName:"Claude Code",loginMethods:["terminal"],connectionOptions:[{id:"claude:anthropic:terminal",providerId:"anthropic",authKind:"subscription",method:"terminal",billingKind:"subscription",executionKind:"native",availability:"available"}]}]);
 render(<AgentsProvidersView {...props} onRefreshForConnection={vi.fn()}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Connect Claude"}));
 expect(within(subscriptions).getAllByText("Not connected")[0]).toBeVisible();
 expect(within(subscriptions).queryByText("Saved connection")).toBeNull();
 expect(within(subscriptions).queryByText("Connected")).toBeNull();
 expect(within(subscriptions).queryByText("Matrix AI")).toBeNull();
 expect(within(subscriptions).queryByText("Usage unavailable")).toBeNull();
 expect(screen.queryByRole("button",{name:"Connect saved connection"})).toBeNull();
 expect(client.startConnection).not.toHaveBeenCalled();
 expect(props.onMutate).not.toHaveBeenCalled();
});
it.each(["owner_subscription", "owner_api_key"] as const)("retains matched native Claude %s connections without another login", async fundingKind => {
 const {props,client,capability}=setup();
 Object.assign(props.snapshot.harnesses[0]!,{id:"claude",harness:"claude",displayName:"Claude Code",authState:"authenticated",enabled:false,configuredEnabled:false,accessSourceId:"native",accountIds:["owner"],selectedAccountId:"owner",route:{kind:"fixed",providerId:"anthropic",modelId:"native"}});
 props.snapshot.accounts=[{id:"owner",accessSourceId:"native",displayName:"Native Claude owner",authMethod:fundingKind === "owner_api_key" ? "api_key" : "terminal",authState:"authenticated",dependencies:{activeChatCount:0,resumableChatCount:0,harnessInstanceCount:1}}] as never;
 props.snapshot.accessSources=[{id:"native",kind:"provider_account",fundingKind,providerId:"anthropic",accountId:"owner",displayName:"Native Claude source",eligibleModelIds:[],readiness:{state:"ready"},usage:{kind:"unavailable",reason:"unknown"}}] as never;
 props.snapshot.supportedActions=["set_harness_enabled"];
 vi.mocked(client.capabilities).mockResolvedValue([{...capability,harnessInstanceId:"claude",harness:"claude",displayName:"Claude Code",loginMethods:["terminal"],connectionOptions:[]}]);
 render(<AgentsProvidersView {...props} onRefreshForConnection={vi.fn()}/>);
 const subscriptions=await screen.findByRole("region",{name:"Your subscriptions"});
 fireEvent.click(await within(subscriptions).findByRole("button",{name:"Manage Claude connection"}));
 expect(within(subscriptions).getByText("Saved connection")).toBeVisible();
 expect(within(subscriptions).getByText("Native Claude owner")).toBeVisible();
 expect(screen.getByRole("button",{name:"Connect saved connection"})).toBeEnabled();
 expect(client.startConnection).not.toHaveBeenCalled();
 expect(client.start).not.toHaveBeenCalled();
});
it("does not borrow a different native account when the configured Claude source account is missing", async () => {
 const {props,client,capability}=setup();
 Object.assign(props.snapshot.harnesses[0]!,{id:"claude",harness:"claude",displayName:"Claude Code",authState:"authenticated",enabled:false,configuredEnabled:false,accessSourceId:"configured",accountIds:["other"],selectedAccountId:"other",route:{kind:"fixed",providerId:"anthropic",modelId:"native"}});
 props.snapshot.accounts=[{id:"other",accessSourceId:"unrelated",displayName:"Another Claude owner",authMethod:"terminal",authState:"authenticated",dependencies:{activeChatCount:0,resumableChatCount:0,harnessInstanceCount:1}}] as never;
 props.snapshot.accessSources=[{id:"configured",kind:"provider_account",fundingKind:"owner_subscription",providerId:"anthropic",accountId:"expected",displayName:"Unmatched Claude account",eligibleModelIds:[],readiness:{state:"ready"},usage:{kind:"unavailable",reason:"unknown"}}] as never;
 props.snapshot.supportedActions=["set_harness_enabled"];
 vi.mocked(client.capabilities).mockResolvedValue([{...capability,harnessInstanceId:"claude",harness:"claude",displayName:"Claude Code",loginMethods:["terminal"],connectionOptions:[]}]);
 render(<AgentsProvidersView {...props} onRefreshForConnection={vi.fn()}/>);
 await waitFor(()=>expect(client.capabilities).toHaveBeenCalled());
 const subscriptions=screen.getByRole("region",{name:"Your subscriptions"});
 expect(within(subscriptions).queryByText("Another Claude owner")).toBeNull();
 expect(within(subscriptions).queryByText("Unmatched Claude account")).toBeNull();
 expect(within(subscriptions).queryByText("Saved connection")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/^Claude Code/}));
 expect(screen.queryByRole("button",{name:"Connect saved connection"})).toBeNull();
 expect(client.startConnection).not.toHaveBeenCalled();
});
it.each(["anthropic", "openai"])("checks source-absent legacy Claude account provider identity (%s)", async providerId => {
 const {props,client,capability}=setup();
 Object.assign(props.snapshot.harnesses[0]!,{id:"claude",harness:"claude",displayName:"Claude Code",authState:"unknown",enabled:false,configuredEnabled:false,accessSourceId:null,accountIds:["owner"],selectedAccountId:"owner",localObservation:{state:"present_unverified",checkedAt:new Date().toISOString(),staleAfter:"2099-10-03T00:00:00Z"},route:{kind:"fixed",providerId:"anthropic",modelId:"native"}});
 props.snapshot.accounts=[{id:"owner",providerId,accessSourceId:"native",displayName:"Legacy native owner",authMethod:"terminal",authState:"authenticated",dependencies:{activeChatCount:0,resumableChatCount:0,harnessInstanceCount:1}}] as never;
 props.snapshot.supportedActions=["set_harness_enabled"];
 vi.mocked(client.capabilities).mockResolvedValue([{...capability,harnessInstanceId:"claude",harness:"claude",displayName:"Claude Code",loginMethods:["terminal"],connectionOptions:[]}]);
 render(<AgentsProvidersView {...props} onRefreshForConnection={vi.fn()}/>);
 await waitFor(()=>expect(client.capabilities).toHaveBeenCalled());
 const subscriptions=screen.getByRole("region",{name:"Your subscriptions"});
 if (providerId === "anthropic") {
  fireEvent.click(await within(subscriptions).findByRole("button",{name:"Manage Claude connection"}));
  expect(within(subscriptions).getByText("Legacy native owner")).toBeVisible();
  expect(screen.getByRole("button",{name:"Connect saved connection"})).toBeEnabled();
 } else {
  expect(within(subscriptions).queryByText("Legacy native owner")).toBeNull();
  expect(within(subscriptions).queryByText("Saved connection")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:/^Claude Code/}));
  expect(screen.queryByRole("button",{name:"Connect saved connection"})).toBeNull();
 }
 expect(client.startConnection).not.toHaveBeenCalled();
});
