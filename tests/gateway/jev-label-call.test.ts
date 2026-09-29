import { expect, it, vi } from "vitest";
import { createJevLabelCallRoutes } from "../../packages/gateway/src/integrations/jev-label-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
it("denies a read-only integration run before account lookup or Gmail calls", async () => {
  const list = vi.fn();
  const app = createJevLabelCallRoutes({ db: { listConnectedServices: list } as unknown as PlatformDb,
    pipedream: {} as PipedreamConnectClient, resolveUserId: async () => "owner_fixture" });
  const response = await app.request("/jev-label-call", { method: "POST", headers: { "content-type": "application/json", "x-matrix-integration-read-scope": "read" }, body: "{}" });
  expect(response.status).toBe(403); expect(list).not.toHaveBeenCalled();
});
it("rejects a normal authenticated owner who forges an enabled binding without verified internal delegation", async () => {
  const list = vi.fn();
  const app = createJevLabelCallRoutes({ db: { listConnectedServices: list } as unknown as PlatformDb,
    pipedream: {} as PipedreamConnectClient, resolveUserId: async () => "owner_fixture" });
  const response = await app.request("/jev-label-call", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({binding:{service:"gmail",accountLabel:"My Gmail",connectionId:"conn_1",expectedEmail:"me@example.test",labelingEnabled:true},input:{threadId:"thread_1",messageIds:["message_1"],labels:["00 • Jev/8 Newsletter"]}}) });
  expect(response.status).toBe(403); expect(list).not.toHaveBeenCalled();
});
it("permits a single exact-message addition only on the verified internal mount", async () => {
  const call = vi.fn(async (raw:unknown) => (raw as {kind:string}).kind === "message-labels"
    ? {id:"message_1",threadId:"thread_1",labelIds:["INBOX"]} : {id:"message_1",threadId:"thread_1",labelIds:["INBOX","Label_News"]});
  const app = createJevLabelCallRoutes({ db: {
    listConnectedServices:async()=>[{id:"conn_1",user_id:"owner_fixture",service:"gmail",status:"active",account_label:"My Gmail",account_email:"me@example.test",pipedream_account_id:"apn_1"}],
    getUserById:async()=>({pipedream_external_id:"owner_fixture"}) } as unknown as PlatformDb,
    pipedream:{boundedGmailGet:async()=>({emailAddress:"me@example.test"}),boundedGmailLabels:call} as unknown as PipedreamConnectClient,
    resolveUserId:async()=>"owner_fixture",authorizeInternal:async()=>true });
  const response = await app.request("/jev-label-call", { method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
    binding:{service:"gmail",accountLabel:"My Gmail",connectionId:"conn_1",expectedEmail:"me@example.test",labelingEnabled:true},
    operation:{kind:"add-labels",threadId:"thread_1",messageId:"message_1",labelIds:["Label_News"]} }) });
  expect(response.status).toBe(200);
  expect(call.mock.calls.filter(([raw])=>(raw as {kind:string}).kind==="add-labels")).toHaveLength(1);
  expect(call.mock.calls.at(-1)?.[0]).toMatchObject({kind:"add-labels",messageId:"message_1",labelIds:["Label_News"]});
});
