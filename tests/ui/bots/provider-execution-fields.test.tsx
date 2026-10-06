// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {cleanup, act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {BotUseAuthorizationPanel} from "../../../packages/ui/src/agents-providers/BotUseAuthorizationPanel";
import {BotTaskExecutorField} from "../../../packages/ui/src/chat-agents/bots/BotTaskExecutorField";
afterEach(cleanup);
HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};
HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};
const connection = {id:"claude_code_tasks", providerId:"anthropic", executionKind:"native_task", availability:"available", models:[{id:"observed-model",displayName:"Observed Claude model"}], authorization:{revision:2,enabled:true,background:false}, coordinatorFunding:"separate"} as const;
const client = () => ({connections:vi.fn().mockResolvedValue({connections:[connection]}), authorizeConnection:vi.fn().mockResolvedValue({connections:[connection]}), execution:vi.fn(), configureExecution:vi.fn()});
it("keeps provider-access-gated ChatGPT unavailable without an ineffective login", async () => {
 const api = client(); api.connections.mockResolvedValue({connections:[{...connection,id:"matrix_chatgpt_plan",providerId:"openai",executionKind:"direct_pi",availability:"unavailable",unavailableReason:"provider_access_required",models:[]}]} as never);
 render(<BotUseAuthorizationPanel client={api as never} harness="codex" disabled={false}/>);
 await screen.findByText(/requires provider approval/);
 expect(screen.queryByRole("button",{name:"Enable for Bots"})).not.toBeInTheDocument();
 expect(api.authorizeConnection).not.toHaveBeenCalled();
});
it("revokes Bot use separately from native sign-out and does not grant background implicitly", async () => {
 const api = client();
 render(<BotUseAuthorizationPanel client={api as never} harness="claude" disabled={false}/>);
 await screen.findByText("Available in Bots");
 expect(screen.getByRole("checkbox")).not.toBeChecked();
 fireEvent.click(screen.getByRole("button",{name:"Disconnect from Bots"}));
 await waitFor(()=>expect(api.authorizeConnection).toHaveBeenCalledWith("claude_code_tasks",{baseRevision:2,enabled:false,background:false},expect.any(AbortSignal)));
});
it("separates Claude task executor from coordinator funding and never picks a model implicitly", () => {
 const change=vi.fn();
 render(<BotTaskExecutorField connections={{connections:[connection]}} value={null} pending={false} onChange={change}/>);
 fireEvent.change(screen.getByRole("combobox",{name:"Task executor"}),{target:{value:"claude_code_tasks"}});
 expect(change).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole("combobox",{name:"Task model"}),{target:{value:"observed-model"}});
 expect(change).toHaveBeenCalledWith({connectionId:"claude_code_tasks",model:"observed-model"});
 expect(screen.getByText(/coordinator still uses its selected connection/)).toBeInTheDocument();
});

it("offers the missing Bot authorization step after native login without another sign-in", async () => {
 const api=client(); api.connections.mockResolvedValue({connections:[{...connection,availability:"setup_required",unavailableReason:"authorization_required",authorization:{revision:0,enabled:false,background:false}}]} as never);
 render(<BotUseAuthorizationPanel client={api as never} harness="claude" disabled={false}/>);
 fireEvent.click(await screen.findByRole("button",{name:"Enable for Bot tasks"}));
 await waitFor(()=>expect(api.authorizeConnection).toHaveBeenCalledWith("claude_code_tasks",{baseRevision:0,enabled:true,background:false},expect.any(AbortSignal)));
});

it("retains a created Bot and retries only failed executor binding", async () => {
 const {AgentRecipesPanel}=await import("../../../packages/ui/src/chat-agents/AgentRecipesPanel");
 const api={...client(), directBot:vi.fn().mockResolvedValue("bot_abcdefgh")};
 api.execution.mockResolvedValue({revision:0,connectionId:null,model:null,grantRevision:null});
 api.configureExecution.mockRejectedValueOnce(new Error("private provider failure")).mockResolvedValue({revision:1,connectionId:"claude_code_tasks",model:"observed-model",grantRevision:2});
 const create=vi.fn().mockResolvedValue("chat_abcdefgh"), open=vi.fn();
 const model={instanceId:"matrix_pi_default",driverKind:"matrix_pi",harnessLabel:"Pi",connectionLabel:"Matrix AI",modelId:"cloudflare:model",modelLabel:"Observed coordinator",interactionMode:"default",interactionModes:["default"],permissionMode:"full_access",permissionModes:["full_access"],options:[],selectedOptions:[],supportsFileAttachments:false};
 render(<AgentRecipesPanel botClient={api as never} botRecipes={[{recipeId:"writer",version:"1",name:"Writer",description:"Writes",output:"Draft"}]} matrixModels={[model as never]} onInstantiateBot={create} onOpenBotChat={open}/>);
 fireEvent.click(screen.getByRole("button",{name:"Use Writer"}));
 await waitFor(()=>expect(screen.getByRole("option",{name:"Claude Code"})).toBeEnabled());
 fireEvent.change(screen.getByRole("combobox",{name:"Task executor"}),{target:{value:"claude_code_tasks"}});
 expect(screen.getByRole("button",{name:"Create bot"})).toBeDisabled();
 fireEvent.change(screen.getByRole("combobox",{name:"Task model"}),{target:{value:"observed-model"}});
 fireEvent.click(screen.getByRole("button",{name:"Create bot"}));
 await screen.findByRole("alert");
 expect(screen.getByRole("textbox",{name:"Name"})).toBeDisabled();
 fireEvent.click(screen.getByRole("button",{name:"Retry task setup"}));
 await waitFor(()=>expect(open).toHaveBeenCalledWith("chat_abcdefgh"));
 expect(create).toHaveBeenCalledOnce(); expect(api.configureExecution).toHaveBeenCalledTimes(2);
 expect(document.body.textContent).not.toContain("private provider failure");
});

it("does not bind a created Bot after its Computer scope changes during readback", async () => {
 const {configureCreatedExecutor}=await import("../../../packages/ui/src/chat-agents/bots/configure-created-executor");
 let current=true;
 const api={...client(),directBot:vi.fn(async()=>{current=false; return "bot_abcdefgh";})};
 await expect(configureCreatedExecutor(api as never,"chat_abcdefgh",{connectionId:"claude_code_tasks",model:"observed-model"},()=>current)).rejects.toThrow();
 expect(api.configureExecution).not.toHaveBeenCalled(); expect(api.execution).not.toHaveBeenCalled();
});

it("keeps a revoked saved task model visible without selecting another model", () => {
 const change=vi.fn();
 render(<BotTaskExecutorField connections={{connections:[{...connection,authorization:{...connection.authorization,enabled:false},availability:"setup_required",unavailableReason:"authorization_required"}]}} value={{connectionId:"claude_code_tasks",model:"observed-model"}} pending={false} onChange={change}/>);
 expect(screen.getByRole("combobox",{name:"Task model"})).toBeDisabled();
 expect(screen.getByText(/will not fall back to another account/)).toBeInTheDocument();
 expect(change).not.toHaveBeenCalled();
});

it("preserves an unsent Bot setup draft while visiting Settings", async () => {
 const {BotRecipeSetup}=await import("../../../packages/ui/src/chat-agents/bots/BotRecipeSetup");
 const api=client(), setup=vi.fn();
 const model={instanceId:"matrix_pi_default",driverKind:"matrix_pi",harnessLabel:"Pi",connectionLabel:"Matrix AI",modelId:"cloudflare:model",modelLabel:"Observed coordinator",interactionMode:"default",interactionModes:["default"],permissionMode:"full_access",permissionModes:["full_access"],options:[],selectedOptions:[],supportsFileAttachments:false};
 render(<BotRecipeSetup botClient={api as never} onSetup={setup} recipe={{recipeId:"writer",version:"1",name:"Writer",description:"Writes",output:"Draft"}} pending={false} error="" selection={{instanceId:model.instanceId,model:model.modelId}} models={[model as never]} onSelectionChange={vi.fn()} onCreate={vi.fn()} onClose={vi.fn()}/>);
 await screen.findByRole("option",{name:"Claude Code"});
 fireEvent.change(screen.getByRole("textbox",{name:"Name"}),{target:{value:"Retained name"}});
 fireEvent.click(screen.getByRole("button",{name:"Connect in Agents & providers"}));
 expect(setup).toHaveBeenCalledOnce();
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Resume bot setup"}));});
 expect(screen.getByRole("textbox",{name:"Name"})).toHaveValue("Retained name");
 expect(screen.getByRole("combobox",{name:"Bot model"})).toHaveValue(JSON.stringify([model.instanceId,model.modelId]));
});

it("clears an uncertain executor binding when explicitly finishing without a task executor",async()=>{
 const {configureCreatedExecutor}=await import("../../../packages/ui/src/chat-agents/bots/configure-created-executor");
 const api={...client(),directBot:vi.fn().mockResolvedValue("bot_abcdefgh")};
 api.execution.mockResolvedValue({revision:1,connectionId:"claude_code_tasks",model:"observed-model",grantRevision:2});
 api.configureExecution.mockResolvedValue({revision:2,connectionId:null,model:null,grantRevision:null});
 await configureCreatedExecutor(api as never,"chat_abcdefgh",null,()=>true,true);
 expect(api.configureExecution).toHaveBeenCalledWith("bot_abcdefgh",{baseRevision:1,connectionId:null});
});

it("keeps a failed Bot authorization visible after safely refreshing its status", async () => {
 const api=client(); api.authorizeConnection.mockRejectedValue(new Error("private failure"));
 render(<BotUseAuthorizationPanel client={api as never} harness="claude" disabled={false}/>);
 fireEvent.click(await screen.findByRole("button",{name:"Disconnect from Bots"}));
 await screen.findByText("Bot authorization could not be updated. Check again.");
 expect(document.body.textContent).not.toContain("private failure");
});

it("shows connect-first guidance for a logged-out qualified native account without offering consent", async () => {
 const api=client(); api.connections.mockResolvedValue({connections:[{...connection,availability:"unavailable",unavailableReason:"authentication_required",authorization:{revision:0,enabled:false,background:false},models:[]}]} as never);
 render(<BotUseAuthorizationPanel client={api as never} harness="claude" disabled={false}/>);
 await screen.findByText("Connect the native account on this computer before enabling Bot use.");
 expect(screen.queryByText("Bot execution is unavailable on this computer.")).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Enable for Bot tasks"})).not.toBeInTheDocument();
 expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
 expect(api.authorizeConnection).not.toHaveBeenCalled();
});

it("keeps unsupported native runtime guidance distinct from missing login", async () => {
 const api=client(); api.connections.mockResolvedValue({connections:[{...connection,availability:"unavailable",unavailableReason:"unsupported_runtime",authorization:{revision:0,enabled:false,background:false},models:[]}]} as never);
 render(<BotUseAuthorizationPanel client={api as never} harness="claude" disabled={false}/>);
 await screen.findByText("Bot execution is unavailable on this computer.");
 expect(screen.queryByText("Connect the native account on this computer before enabling Bot use.")).not.toBeInTheDocument();
 expect(api.authorizeConnection).not.toHaveBeenCalled();
});
