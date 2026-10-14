import { expect, it, vi } from "vitest";
import { createCreationConversation, creationConversationSelection } from "../../../packages/ui/src/chat-agents/creation-conversation.js";
import type { CreationConversationClient } from "../../../packages/ui/src/chat-agents/creation-conversation.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import type { BotCreationSnapshot, CanonicalChatDetailResponse, CanonicalChatTurnAdmissionResponse } from "@matrix-os/contracts";

const now = "2026-10-14T00:00:00.000Z";
const selection = { instanceId: "matrix_pi_default", model: "matrix-model" };
const snapshot: BotCreationSnapshot = {sessionId: "creation_session", draftRevision: 3, seed: {kind: "scratch"},
  draft: {name: "", description: "", instructions: "", selection, taskExecutor: {connectionId: "claude_code_tasks", model: null}}};
function fixture() {
  const detail: CanonicalChatDetailResponse = {record: {chat: {id: "chat_creation", ownerScope: {type:"personal",ownerId:"owner"}, title:"New agent", lifecycle:"active", attention:"none", revision:0,messageCount:0,createdAt:now,updatedAt:now}},messages:[],turns:[],runs:[],activities:[]};
  const client = {create:vi.fn<CreationConversationClient["create"]>(async () => detail.record), detail:vi.fn<CreationConversationClient["detail"]>(async () => detail),
    admitTurn:vi.fn<CreationConversationClient["admitTurn"]>(async () => ({record:detail.record,run:{id:"run_creation"}} as CanonicalChatTurnAdmissionResponse)), cancelRun:vi.fn<CreationConversationClient["cancelRun"]>(async () => {})};
  let current = true;
  const onProposal = vi.fn(() => true);
  const conversation = createCreationConversation({client,sessionId:snapshot.sessionId,isCurrent:()=>current,onProposal,onChange:vi.fn()});
  return {conversation,client,detail,onProposal,expire:()=>{current=false;}};
}
it("uses the catalog's actual Matrix AI default without falling back to another provider", () => {
  const catalog=createCanonicalProviderCatalogFixture();
  expect(creationConversationSelection(catalog)).toBeNull();
  catalog.instances.push({...catalog.instances[0]!,id:selection.instanceId,driverKind:"matrix_pi",defaultSelection:selection,models:[{...catalog.instances[0]!.models[0]!,id:selection.model}]});
  expect(creationConversationSelection(catalog)).toEqual(selection);
  catalog.instances.at(-1)!.models[0]!.availability="unavailable";
  expect(creationConversationSelection(catalog)).toBeNull();
});
it("sends a real canonical turn carrying the exact bounded draft including incomplete executor intent", async () => {
  const {conversation,client}=fixture();
  expect(await conversation.send("Help configure this Bot",snapshot,selection)).toBe(true);
  expect(client.admitTurn).toHaveBeenCalledWith("chat_creation",expect.objectContaining({botCreation:snapshot,selection,permissionMode:"supervised",parts:[{type:"text",text:"Help configure this Bot"}]}));
  expect(conversation.state().activeRunId).toBe("run_creation");
});
it("reuses the uncertain exact turn request on retry instead of duplicating model inference", async () => {
  const {conversation,client}=fixture();
  client.admitTurn.mockRejectedValueOnce(new Error("connection lost"));
  expect(await conversation.send("Configure",snapshot,selection)).toBe(false);
  expect(await conversation.send("Configure",snapshot,selection)).toBe(true);
  expect(client.create).toHaveBeenCalledTimes(1);
  expect(client.admitTurn.mock.calls[0]![1]).toEqual(client.admitTurn.mock.calls[1]![1]);
});
it("does not continue to paid turn admission after the creation session expires while Chat creation awaits", async () => {
  const {conversation,client,detail,expire}=fixture();
  let resolve!:(value:typeof detail.record)=>void;
  client.create.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  const sending=conversation.send("Configure",snapshot,selection);
  expire(); resolve(detail.record);
  expect(await sending).toBe(false); expect(client.admitTurn).not.toHaveBeenCalled();
});
it("applies only a genuine proposal for this admitted run/session once; prose is not configuration", async () => {
  const {conversation,detail,onProposal}=fixture();
  await conversation.send("Configure",snapshot,selection);
  detail.activities.push({id:"activity_creation",chatId:"chat_creation",runId:"run_creation",occurredAt:now,
    type:"bot.draft.proposed",proposalId:"proposal_creation",sessionId:snapshot.sessionId,baseDraftRevision:3,patch:{name:"Proposed"}});
  await conversation.refresh(); await conversation.refresh();
  expect(onProposal).toHaveBeenCalledTimes(1);
  detail.activities.push({...detail.activities[0]!,id:"activity_other",runId:"run_other",proposalId:"proposal_other"} as typeof detail.activities[number]);
  await conversation.refresh(); expect(onProposal).toHaveBeenCalledTimes(1);
});
it("discards a late readback after owner expiry without applying a proposal", async () => {
  const {conversation,client,detail,onProposal,expire}=fixture();
  await conversation.send("Configure",snapshot,selection);
  let resolve!:(value:typeof detail)=>void;
  client.detail.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  const refreshing=conversation.refresh(); expire(); resolve(detail);
  await refreshing; expect(onProposal).not.toHaveBeenCalled();
});
