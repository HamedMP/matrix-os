import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), validate: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("../../packages/gateway/src/integrations/custom-mcp/security.js", () => ({ validateCustomMcpUrl: mocks.validate }));
import { pinnedRemoteMcpRequester, RemoteMcpClient, type RemoteMcpRequest } from "../../packages/gateway/src/integrations/custom-mcp/client.js";

it("delivers complete split SSE notifications before the HTTP response finishes, retaining pinned transport and final JSON", async () => {
  mocks.validate.mockResolvedValue({ url: new URL("https://mcp.example.com/mcp"), address: "93.184.216.34", family: 4 });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "text/event-stream" }, destroy: vi.fn() });
  const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  mocks.request.mockImplementation((_url, _options, receive) => { queueMicrotask(() => receive(response)); return request; });
  const messages: unknown[] = [];
  const work = pinnedRemoteMcpRequester({ url: "https://mcp.example.com/mcp", headers: {}, timeoutMs: 1000, onNotification: value => messages.push(value) });
  await vi.waitFor(() => expect(response.listenerCount("data")).toBe(1));
  const notice = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "one", progress: 1, message: "phase one" } });
  response.emit("data", Buffer.from(`data: ${notice.slice(0, 45)}`));
  expect(messages).toEqual([]);
  response.emit("data", Buffer.from(`${notice.slice(45)}\n\n`));
  expect(messages).toHaveLength(1); // No end event yet: this must be live data.
  response.emit("data", Buffer.from('data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n'));
  response.emit("end");
  await expect(work).resolves.toMatchObject({ body: { id: 2, result: { content: [] } } });
  expect(mocks.request.mock.calls[0][1]).toMatchObject({ servername: "mcp.example.com", lookup: expect.any(Function) });
});

it("requests per-invocation progress and ignores foreign tokens, invalid payloads and late notifications", async () => {
  let notify!: (value: unknown) => void;
  const progress: unknown[] = [];
  let token: unknown;
  const requester = async (request: RemoteMcpRequest) => {
    const body = request.body as { id?: number; method: string; params?: { _meta?: { progressToken?: string } } };
    if (body.method === "tools/call") {
      token = body.params?._meta?.progressToken;
      notify = request.onNotification!;
      notify({ method: "notifications/progress", params: { progressToken: "other", progress: 1, message: "foreign" } });
      notify({ method: "notifications/progress", params: { progressToken: token, progress: -1 } });
      notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, message: "phase one", other: "PRIVATE" } });
    }
    return { status: 200, headers: {}, body: { id: body.id, result: { protocolVersion: "2025-06-18", content: [] } } };
  };
  const client = new RemoteMcpClient({ requester });
  await client.callTool({ serverId: "server", url: "https://mcp.example.com/mcp", toolName: "echo", onProgress: value => progress.push(value) });
  expect(typeof token).toBe("string");
  expect(progress).toEqual([{ progress: 1, message: "phase one" }]);
  notify({ method: "notifications/progress", params: { progressToken: token, progress: 2, message: "late" } });
  expect(progress).toHaveLength(1);
  await client.shutdown();
});

it("does not terminate a shared remote session when one streaming invocation is cancelled", async () => {
  const abort = new AbortController();
  const methods: string[] = [];
  const client = new RemoteMcpClient({ requester: async request => {
    const body = request.body as { id?: number; method: string } | undefined;
    methods.push(request.method === "DELETE" ? "DELETE" : body!.method);
    if (body?.method === "tools/call") { abort.abort(); throw new Error("cancelled"); }
    return { status: 200, headers: { "mcp-session-id": "shared" }, body: { id: body?.id, result: { protocolVersion: "2025-06-18" } } };
  } });
  await expect(client.callTool({ serverId: "server", url: "https://mcp.example.com/mcp", toolName: "echo", signal: abort.signal, onProgress: () => {} })).rejects.toThrow("cancelled");
  expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  await client.shutdown();
  expect(methods.at(-1)).toBe("DELETE");
});
