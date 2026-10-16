// @vitest-environment jsdom
import React from "react";
import {act,cleanup,render} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {BotCreationSnapshot,CanonicalProviderCatalog} from "@matrix-os/contracts";
import {useCreationConversation} from "../../../packages/ui/src/chat-agents/useCreationConversation.js";
import type {CreationConversationClient} from "../../../packages/ui/src/chat-agents/creation-conversation.js";
import {createCanonicalProviderCatalogFixture} from "../../contracts/fixtures/canonical-chat.js";
afterEach(cleanup);
const selection={instanceId:"matrix_pi_default",model:"matrix-model"};
const snapshot:BotCreationSnapshot={sessionId:"creation_one",draftRevision:0,seed:{kind:"scratch"},draft:{name:"",description:"",instructions:"",selection}};
const catalog:CanonicalProviderCatalog=createCanonicalProviderCatalogFixture();
catalog.instances.push({...catalog.instances[0]!,id:selection.instanceId,driverKind:"matrix_pi",defaultSelection:selection,models:[{...catalog.instances[0]!.models[0]!,id:selection.model}]});
function client():CreationConversationClient{return{create:vi.fn(),detail:vi.fn(),admitTurn:vi.fn(),cancelRun:vi.fn()};}
let observed!:ReturnType<typeof useCreationConversation>;
function Harness({transport,revision=0}:{transport:CreationConversationClient;revision?:number}){
  const current=useCreationConversation({client:transport,snapshot:{...snapshot,draftRevision:revision},catalog,isCurrent:()=>true,onProposal:()=>true});
  React.useLayoutEffect(()=>{observed=current;});return null;
}
it("keeps message text through configuration revisions without reseeding a conversation",()=>{
  const transport=client();const view=render(<Harness transport={transport}/>);
  act(()=>observed.setText("Keep my configuration request"));
  view.rerender(<Harness transport={transport} revision={4}/>);
  expect(observed.text).toBe("Keep my configuration request");expect(transport.create).not.toHaveBeenCalled();
});
it("does not leak message text or retained callbacks across owner A→B→A",()=>{
  const first=client(),second=client();const view=render(<Harness transport={first}/>);
  act(()=>observed.setText("Owner A"));const old=observed;
  view.rerender(<Harness transport={second}/>);expect(observed.text).toBe("");
  view.rerender(<Harness transport={first}/>);
  act(()=>old.setText("Stale owner A"));expect(observed.text).toBe("");
  expect(first.admitTurn).not.toHaveBeenCalled();
});
it("keeps the live hook usable under StrictMode effect replay",()=>{
  render(<React.StrictMode><Harness transport={client()}/></React.StrictMode>);
  act(()=>observed.setText("Current draft"));expect(observed.text).toBe("Current draft");expect(observed.available).toBe(true);
});
