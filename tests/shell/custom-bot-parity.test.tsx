// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
import { saved, clientFixture } from "../desktop/chat-agents-fixture.js";
const state = vi.hoisted(()=>({ catalog: null as unknown }));
vi.mock("../../shell/src/components/chat-app-provider-setup.js", ()=>({
 useChatProviderState: ()=>({ catalog:state.catalog, loading:false, selected:null, refresh:vi.fn() }), ChatProviderSetupPanel:()=>null,
}));
vi.mock("@clerk/nextjs", async original=>({...(await original<typeof import("@clerk/nextjs")>()),useOrganization:()=>({organization:null}),useAuth:()=>({userId:null,sessionId:null})}));
afterEach(cleanup);
it.each(["Web Canvas","Web Desktop","Web Mobile"])("%s keeps a custom Bot executor and resets explicit Full access after sending",async surface=>{
 const catalog=createCanonicalProviderCatalogFixture(),base=catalog.instances[0]!;
 catalog.instances=[{...base,id:saved.selection.instanceId,driverKind:"hermes",displayName:"Hermes",models:[{...base.models[0]!,id:saved.selection.model}],supports:{...base.supports,permissionModes:["full_access"]}}];state.catalog=catalog;
 const baseClient=clientFixture();baseClient.list.mockResolvedValue({enabled:true,agents:[saved]});
 const bots={directBot:vi.fn(async()=>saved.id),directChat:vi.fn(async()=>"chat_custom"),interactions:vi.fn(),tasks:vi.fn(),authority:vi.fn()};
 const submit=vi.fn(async()=>true);
 render(<ChatApp mobile={surface==="Web Mobile"} messages={[]} sessionId="chat_custom" busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={submit} agentClient={{...baseClient,bots} as never}/>);
 await screen.findByText(saved.name); const input=screen.getByRole("textbox",{name:/message/i});
 fireEvent.change(input,{target:{value:"Read only"}});
 expect(screen.getByRole("button",{name:/send/i})).toHaveProperty("disabled",true);
 const consent=screen.getByRole("checkbox",{name:"Allow Full access on this computer for this Bot request."});fireEvent.click(consent);
 fireEvent.click(screen.getByRole("button",{name:/send/i}));
 await waitFor(()=>expect(submit).toHaveBeenCalledWith("Read only",undefined,expect.objectContaining({instanceId:saved.selection.instanceId,model:saved.selection.model,permissionMode:"full_access",resources:[{kind:"agent",id:saved.id,label:saved.name,revision:"1"}]})));
 await waitFor(()=>expect(consent).toHaveProperty("checked",false));
 expect(bots.authority).not.toHaveBeenCalled();expect(bots.interactions).not.toHaveBeenCalled();expect(bots.tasks).not.toHaveBeenCalled();
 expect(document.querySelector('[data-slot="chat-session-header"]')).toBeNull();
});
