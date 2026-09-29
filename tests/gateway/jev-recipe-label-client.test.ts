import { expect, it, vi } from "vitest";
import { createJevRecipeLabelClient } from "../../packages/gateway/src/jev/recipe-label-client.js";
it("forwards only the saved granted account and server-provided additive label plan with signed owner delegation", async () => {
  let added = false;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/read-call")) return Response.json({ service: "gmail", action: "get_profile", data: { emailAddress: "me@example.test" } });
    const operation = body.operation;
    if (operation.kind === "labels") return Response.json({ labels: [{id:"Label_News",name:"00 • Jev/8 Newsletter",type:"user"}] });
    if (operation.kind === "message-labels") return Response.json({ id:"message_1",threadId:"thread_1",labelIds:added?["INBOX","Label_News"]:["INBOX"] });
    if (operation.kind === "add-labels") { added=true; return Response.json({}); }
    throw new Error("Unexpected operation");
  });
  const label = createJevRecipeLabelClient({ internalBaseUrl: "https://platform.internal/integrations", machineToken: "synthetic", fetcher });
  const scope = { kind: "jev_inbox_preview" as const, runId: "run_1", agentId: "agent_1", revision: 1,
    account: { service: "gmail" as const, accountLabel: "My Gmail", connectionId: "conn_1", expectedEmail: "me@example.test", labelingEnabled: true } };
  const authorize = vi.fn(async () => undefined);
  await expect(label("owner_fixture", scope, { threadId: "thread_1", messageIds: ["message_1"], labels: ["00 • Jev/8 Newsletter"] }, undefined, authorize))
    .resolves.toEqual({confirmed:true,messageIds:["message_1"],labelIds:["Label_News"]});
  const [url, init] = fetcher.mock.calls.find(([,init])=>JSON.parse(String(init.body)).operation?.kind === "add-labels")!;
  expect(url).toBe("https://platform.internal/integrations/jev-label-call");
  expect(new Headers(init.headers).get("x-platform-user-id")).toBe("owner_fixture");
  expect(new Headers(init.headers).get("x-platform-verified")).toBeTruthy();
  expect(JSON.parse(String(init.body))).toEqual({ binding: scope.account,
    operation: {kind:"add-labels",threadId:"thread_1",messageId:"message_1",labelIds:["Label_News"]} });
  expect(authorize).toHaveBeenCalled();
});
it("stops remote subsequent writes when authorization is revoked after one message update", async () => {
  let revoked = false;
  const added = new Set<string>();
  const authorize = vi.fn(async () => { if (revoked) throw new Error("Saved grant revoked"); });
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const operation = JSON.parse(String(init.body)).operation;
    if (url.endsWith("/read-call")) return Response.json({service:"gmail",action:"get_profile",data:{emailAddress:"me@example.test"}});
    if (operation.kind === "labels") return Response.json({labels:[{id:"Label_News",name:"00 • Jev/8 Newsletter",type:"user"}]});
    if (operation.kind === "message-labels") return Response.json({id:operation.messageId,threadId:"thread_1",labelIds:added.has(operation.messageId)?["INBOX","Label_News"]:["INBOX"]});
    if (operation.kind === "add-labels") { added.add(operation.messageId); revoked=true; return Response.json({}); }
    throw new Error("Unexpected operation");
  });
  const label = createJevRecipeLabelClient({internalBaseUrl:"https://platform.internal/integrations",machineToken:"synthetic",fetcher});
  const scope = {kind:"jev_inbox_preview" as const,runId:"run_1",agentId:"agent_1",revision:1,
    account:{service:"gmail" as const,accountLabel:"My Gmail",connectionId:"conn_1",expectedEmail:"me@example.test",labelingEnabled:true}};
  await expect(label("owner_fixture",scope,{threadId:"thread_1",messageIds:["message_1","message_2"],labels:["00 • Jev/8 Newsletter"]},undefined,authorize)).rejects.toThrow();
  const mutations = fetcher.mock.calls.map(([,init])=>JSON.parse(String(init.body)).operation).filter(operation=>operation?.kind==="add-labels");
  expect(mutations).toEqual([{kind:"add-labels",messageId:"message_1",threadId:"thread_1",labelIds:["Label_News"]}]);
  expect(added.has("message_2")).toBe(false);
});
