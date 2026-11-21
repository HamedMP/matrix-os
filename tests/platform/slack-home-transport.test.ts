import { describe,it,expect,vi } from "vitest";
import { createSlackHomeTransport } from "../../packages/platform/src/slack-home-transport.js";
import { SlackThreadContextEnvelopeSchema, verifySlackBridgeRequest } from "../../packages/contracts/src/slack-bridge.js";

const token="a".repeat(64);
describe("Slack home transport",()=>{
  it("preserves the original strict context body for an older owner while carrying source outside it", async () => {
    const envelope = {
      ownerId: "user_host", botId: "bot_12345678", chatId: "chat_private", runtimeId: "runtime_preview", grantId: "d".repeat(64),
      event: { eventId: "Ev123", appId: "A123", teamId: "T123", userId: "U123", channelId: "C123",
        ts: "1795000000.000001", threadTs: "1795000000.000001", text: "ordinary source" },
      source: { version: 1, ownerMention: false, textDigest: "c".repeat(64), proof: "e".repeat(64) },
      summary: { ruleId: "legacy-rule", version: 1, proof: "f".repeat(64) },
    };
    const oldConsumer = SlackThreadContextEnvelopeSchema.omit({ source: true }).strict();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String(init!.body);
      const parsed = oldConsumer.safeParse(JSON.parse(body));
      const headers = new Headers(init!.headers);
      expect(await verifySlackBridgeRequest({
        token, path: "/api/internal/slack/context", body,
        timestamp: headers.get("x-matrix-slack-timestamp")!, signature: headers.get("x-matrix-slack-signature")!,
      })).toBe(true);
      expect(parsed.success).toBe(true);
      expect(headers.get("x-matrix-slack-source-v1")).toBe(JSON.stringify(envelope.source));
      expect(headers.get("x-matrix-slack-source-signature")).toMatch(/^[a-f0-9]{64}$/);
      return Response.json({ accepted: true }, { status: 202 });
    });
    await expect(createSlackHomeTransport({ fetchImpl })({ ownerId: "user_host", origin: "https://192.0.2.1", token }, "context", envelope))
      .resolves.toEqual({ accepted: true });
  });
  it("signs the exact trusted destination and only accepts a durable home acknowledgement",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted:true}),{status:202}));
    const rpc=createSlackHomeTransport({fetchImpl});
    const home={ownerId:"user_host",origin:"https://192.0.2.1",token};
    await expect(rpc(home,"events",{ownerId:"user_host",text:"private transient text"})).resolves.toEqual({accepted:true});
    const [url,init]=fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://192.0.2.1/api/internal/slack/events");
    expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers=new Headers(init.headers);
    expect(await verifySlackBridgeRequest({token,path:"/api/internal/slack/events",body:init.body,
      timestamp:headers.get("x-matrix-slack-timestamp")!,signature:headers.get("x-matrix-slack-signature")!})).toBe(true);
    expect(headers.has("authorization")).toBe(false);
    fetchImpl.mockResolvedValue(new Response("{}",{status:503}));
    await expect(rpc(home,"events",{})).rejects.toThrow("Slack home unavailable");
  });
  it("rejects oversized home replies and hostile configured origins",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue(new Response("x".repeat(5000)));
    const rpc=createSlackHomeTransport({fetchImpl});
    await expect(rpc({ownerId:"user_host",origin:"https://192.0.2.1",token},"authorize",{})).rejects.toThrow("Slack home unavailable");
    await expect(rpc({ownerId:"user_host",origin:"https://attacker.example/extra",token},"authorize",{})).rejects.toThrow("Slack home unavailable");
  });
});
