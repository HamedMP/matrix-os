import { expect, it, vi } from "vitest";
import { createJevInboxRuntime } from "../../packages/gateway/src/jev/inbox-runtime.js";
import { saved } from "../desktop/chat-agents-fixture";
import type { BatchDocument, JevInboxBatchStore } from "../../packages/gateway/src/jev/inbox-batch-store.js";
import { JEV_EMAIL_TRIAGE_ANSWER_IDS } from "@matrix-os/contracts";
import type { ChatAgent } from "@matrix-os/contracts";
import type { HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
const owner = "owner_fixture";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: saved.id, revision: 1,
  account: { service: "gmail", accountLabel: "Work", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
const agent: ChatAgent = { ...saved, selection: { instanceId: "hermes_default", model: "anthropic:claude-sonnet-4-6" },
  recipe: { skills: ["matrix-jev-email-triage", "matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Work" }], output: "Read-only proposals",
    jevInboxTriage: { version: 1, ownerId: owner, ...scope.account } } };
function fixture(mode = "ready") {
  const getAgent = vi.fn(async () => mode === "missing" ? null : { ...agent, revision: mode === "stale" ? 2 : 1 });
  const credentials = vi.fn(async () => {
    if (mode === "unsupported") throw new Error("fixture unsupported");
    return { provider: "anthropic" as const, model: "claude-sonnet-4-6", apiMode: "anthropic_messages" as const,
      baseUrl: "https://api.anthropic.com" as const, env: { ANTHROPIC_API_KEY: "synthetic" } };
  });
  const funded = vi.fn(async () => mode !== "unfunded");
  const read = vi.fn(async (_owner: string, _scope: HermesJevScope, action: string) => {
    if (action === "get_profile") return { emailAddress: "me@example.test" };
    return { threads: [] };
  });
  const evaluate = vi.fn();
  const runtime = createJevInboxRuntime({ ownerId: owner, getAgent, resolveCredentials: credentials,
    verifyRuntime: vi.fn(async () => undefined), fundedPolicyReady: vi.fn(async () => mode !== "unfunded"), fundedReady: funded, read, evaluate });
  return { runtime, getAgent, credentials, funded, read, evaluate };
}
it("admission validates selected source and funding without mailbox reads or inference", async () => {
  const f = fixture(); await f.runtime.admit(owner, agent);
  expect(f.credentials).toHaveBeenCalledWith(owner, agent.selection, expect.any(AbortSignal));
  expect(f.funded).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
});
it("matches profile before paid probe and denies preview while the probe is provisional", async () => {
  const f = fixture(); let resolve!: (value: boolean) => void;
  let profileActionsAtProbe: string[] = [];
  const waiting = new Promise<boolean>(done => { resolve = done; });
  f.funded.mockImplementationOnce(async () => {
    profileActionsAtProbe = f.read.mock.calls.map(call => call[2]);
    return waiting;
  });
  const controller = new AbortController();
  const preflight = f.runtime.launch.preflight(owner, scope, controller.signal).then(() => null, error => error);
  await vi.waitFor(() => expect(f.funded).toHaveBeenCalledOnce());
  expect(profileActionsAtProbe).toEqual(["get_profile"]);
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
  expect(f.read.mock.calls.every(call => call[2] === "get_profile")).toBe(true);
  controller.abort(); resolve(true);
  expect(await preflight).toBeInstanceOf(Error);
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
});
it("rejects mismatched live profile with zero paid probes", async () => {
  const f = fixture(); f.read.mockResolvedValueOnce({ emailAddress: "other@example.test" });
  await expect(f.runtime.launch.preflight(owner, scope, new AbortController().signal)).rejects.toThrow();
  expect(f.funded).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
});
it.each(["unsupported", "unfunded", "missing", "stale"])("denies %s before primary run preflight", async mode => {
  const f = fixture(mode); await expect(f.runtime.admit(owner, agent)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
});
it("requires active preflight and server binding, and stops on cancellation", async () => {
  const f = fixture(); const controller = new AbortController();
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
  await f.runtime.launch.preflight(owner, scope, controller.signal);
  expect(f.read.mock.calls.map(call => call[2])).toEqual(["get_profile"]);
  await expect(f.runtime.broker.execute(owner, { ...scope, account: { ...scope.account, connectionId: "foreign" } }, { operation: "discover" })).rejects.toThrow();
  controller.abort();
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
  expect(f.evaluate).not.toHaveBeenCalled();
});
it("revocation blocks later calls while ordinary owner cannot use another run", async () => {
  const f = fixture(); await f.runtime.launch.preflight(owner, scope, new AbortController().signal);
  await expect(f.runtime.broker.execute("wrong_owner", scope, { operation: "discover" })).rejects.toThrow();
  f.runtime.launch.clearRun(owner, scope.runId);
  await expect(f.runtime.broker.execute(owner, scope, { operation: "discover" })).rejects.toThrow();
});

it("wires a paginated batch through admitted scope, evidence, Jev and exact labeling, then denies revoked grant", async () => {
  let checkpoint: BatchDocument | null = null;
  const store: JevInboxBatchStore = {
    async get() {return checkpoint ? structuredClone(checkpoint) : null;},
    async open(d) {checkpoint = structuredClone(d); return structuredClone(d);},
    async save(d,rev) {if(checkpoint?.revision!==rev)throw new Error("Conflict");checkpoint=structuredClone(d);return structuredClone(d);},
  };
  const boundScope = {...scope,account:{...scope.account,labelingEnabled:true}};
  let current: ChatAgent = {...agent,recipe:{...agent.recipe!,jevInboxLabeling:true,
    jevInboxTriage:{version:1,ownerId:owner,...boundScope.account}}};
  const label=vi.fn(async (_o:string,_s:HermesJevScope,input:{messageIds:string[]},_signal?:AbortSignal,check?:()=>Promise<void>)=>{
    await check?.();return {confirmed:true as const,messageIds:input.messageIds,labelIds:["Label_Cold"]};
  });
  const read=vi.fn(async (_o:string,_s:HermesJevScope,action:string,params?:Record<string,unknown>)=>{
    if(action==="get_profile")return {emailAddress:"me@example.test"};
    if(action==="list_threads")return {threads:[{id:"thread_a"},{id:"thread_b"}]};
    if(action==="get_thread_ids")return {id:params?.threadId,historyId:"snapshot",messages:[{id:params?.threadId+"_message",internalDate:"1000"}]};
    if(action==="get_message")return {id:params?.messageId,threadId:String(params?.messageId).replace("_message",""),internalDate:"1000",
      payload:{mimeType:"text/plain",body:{data:Buffer.from("Complete synthetic email.").toString("base64url")}}};
    throw new Error("Unexpected read");
  });
  const evaluate=vi.fn(async()=>({requestId:"jev_req_batch_fixture",recipe:"email-triage-v1" as const,model:"typesafe/jev" as const,latencyMs:1,
    answers:JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id=>({id,type:"boolean" as const,probability:id==="cold_outreach"?0.94:0.1}))}));
  const f=fixture();const runtime=createJevInboxRuntime({ownerId:owner,getAgent:async()=>current,resolveCredentials:f.credentials,
    verifyRuntime:async()=>undefined,fundedPolicyReady:async()=>true,fundedReady:async()=>true,read,evaluate,label,batchStore:store});
  const controller=new AbortController();await runtime.launch.preflight(owner,boundScope,controller.signal);
  const start=await runtime.broker.execute(owner,boundScope,{operation:"batch_start"});
  if(start.kind!=="batch")throw new Error("Batch missing");
  const first=await runtime.broker.execute(owner,boundScope,{operation:"batch_next",jobId:start.jobId,revision:start.revision});
  expect(first).toMatchObject({kind:"batch",status:"ready",labeled:1});
  expect(label.mock.calls[0]?.[1].runId).toBe(scope.runId);
  expect(label.mock.calls[0]?.[2]).toEqual({threadId:"thread_a",messageIds:["thread_a_message"],labels:["00 • Jev/9 Cold outreach"]});
  if(first.kind!=="batch")throw new Error("Batch missing");
  current={...current,revision:2};
  await expect(runtime.broker.execute(owner,boundScope,{operation:"batch_next",jobId:start.jobId,revision:first.revision})).rejects.toThrow();
  expect(label).toHaveBeenCalledOnce();expect(evaluate).toHaveBeenCalledOnce();
  controller.abort();await runtime.close();
  expect(checkpoint).toMatchObject({status:"paused",items:[{id:"thread_a",status:"labeled"}]});
});
