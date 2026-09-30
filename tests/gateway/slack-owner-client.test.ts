import {describe,it,expect,vi} from "vitest";
import {createSlackOwnerClient} from "../../packages/gateway/src/startup/slack-owner-client.js";
describe("Slack owner client",()=>{
  const envelope={event:{teamId:"T123",eventId:"Ev123"}} as never;
  it("never sends a caller-selected Slack destination or credentials in source material",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue(new Response(JSON.stringify({sent:true,messageTs:"123.45"})));
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"alice",token:"a".repeat(64),fetchImpl});
    expect(await client.sendReply({envelope,text:"answer"} as never)).toEqual({status:"sent",messageTs:"123.45"});
    const [url,init]=fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://platform.example/internal/slack/replies");
    expect(JSON.parse(init.body)).toEqual({teamId:"T123",eventId:"Ev123",text:"answer"});
    expect(init.redirect).toBe("error");expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("reacts only to the original receipt and never accepts a destination or emoji",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue(new Response(JSON.stringify({reacted:true})));
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"alice",token:"a".repeat(64),fetchImpl});
    await client.react(envelope);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://platform.example/internal/slack/reactions");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({teamId:"T123",eventId:"Ev123"});
    fetchImpl.mockRejectedValue(new Error("network"));await expect(client.react(envelope)).resolves.toBeUndefined();
  });
  it("marks network outcomes uncertain and caps fetched thread context",async()=>{
    const fetchImpl=vi.fn().mockRejectedValue(new Error("network"));
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"alice",token:"a".repeat(64),fetchImpl});
    expect(await client.sendReply({envelope,text:"answer"} as never)).toEqual({status:"uncertain"});
    fetchImpl.mockResolvedValue(new Response("x".repeat(20_000)));
    expect(await client.readThread(envelope)).toBeNull();
  });
});
