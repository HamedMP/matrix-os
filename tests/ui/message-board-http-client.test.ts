import { describe, expect, it, vi } from "vitest";
import { MessageBoardError } from "../../packages/ui/src/message-board/client";
import { createHttpMessageBoardClient, type BoardEventsSocket } from "../../packages/ui/src/message-board/http-client";

const root = { id: "msg_root12345678", channel: "security/findings", text: "Finding", re: null, replyTo: null, by: { id: "user:o", kind: "user", name: "O" }, labels: {}, reactions: [], revision: 1, createdAt: "2026-11-20T10:00:00.000Z" };

function fetcher(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; method: string; body: unknown; signal: unknown }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal });
    const [status, body] = responses.shift() ?? [200, {}];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("HTTP message board client", () => {
  it("calls the board routes with the board name, a timeout and the thread's channel for replies", async () => {
    const { fn, calls } = fetcher([
      [200, { threads: [{ root, replyCount: 0, latestReply: null, lastActivityAt: root.createdAt, task: null, unread: false }] }],
      [201, { message: { ...root, id: "msg_reply1234567", re: root.id } }],
      [200, { ok: true }],
    ]);
    const client = createHttpMessageBoardClient({ baseUrl: "https://app.example/vm/me/", fetch: fn });
    await client.listThreads("Ops", "security/");
    await client.reply("Ops", root.id, { text: "On it" });
    await client.blockTask("Ops", root.id, "Need approval", "needs_input");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://app.example/vm/me/api/board/threads?channel=security%2F&limit=200&board=Ops",
      "POST https://app.example/vm/me/api/board/messages?board=Ops",
      `POST https://app.example/vm/me/api/board/tasks/${root.id}/block?board=Ops`,
    ]);
    expect(calls[1]!.body).toEqual({ channel: "security/findings", text: "On it", re: root.id });
    expect(calls[2]!.body).toEqual({ reason: "Need approval", kind: "needs_input" });
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it("creates tasks through /tasks and maps failures to stable reasons only", async () => {
    const { fn, calls } = fetcher([
      [201, { root, task: { state: "ready" } }],
      [409, { error: "Someone else holds this task.", reason: "task_claimed" }],
      [500, { error: "SELECT * FROM board /private" }],
      [404, { error: "Not found." }],
    ]);
    const client = createHttpMessageBoardClient({ baseUrl: "http://gw", fetch: fn });
    expect((await client.post("General", { channel: "dev", text: "Fix", task: { forProfile: "reviewer" } })).id).toBe(root.id);
    expect(calls[0]).toMatchObject({ url: "http://gw/api/board/tasks?board=General", body: { channel: "dev", text: "Fix", forProfile: "reviewer" } });
    await expect(client.claimTask("General", root.id)).rejects.toMatchObject({ reason: "task_claimed" });
    const failure = await client.listChannels("General").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MessageBoardError);
    expect((failure as MessageBoardError).reason).toBe("unavailable");
    expect(String((failure as Error).message)).not.toContain("private");
    // Watchers and schedules arrive in a later layer: a missing route is an empty list.
    expect(await client.listWatchers("General")).toEqual([]);
  });

  it("streams live events, pings, and resumes from the last cursor after a drop", async () => {
    vi.useFakeTimers();
    try {
      const sockets: Array<BoardEventsSocket & { url: string; sent: string[] }> = [];
      const urls: Array<Record<string, string>> = [];
      const client = createHttpMessageBoardClient({
        baseUrl: "http://gw",
        fetch: fetcher([]).fn,
        eventsUrl: (query) => { urls.push(query); return `ws://gw/ws/board/events?${new URLSearchParams(query)}`; },
        createSocket: (url) => {
          const socket = { url, sent: [] as string[], send(data: string) { this.sent.push(data); }, close: vi.fn(), onopen: null, onmessage: null, onclose: null, onerror: null } as BoardEventsSocket & { url: string; sent: string[] };
          sockets.push(socket);
          return socket;
        },
      });
      const seen: string[] = [];
      const stop = client.subscribe("General", (event) => seen.push(event.cursor));
      await vi.advanceTimersByTimeAsync(0);
      const first = sockets[0]!;
      first.onopen?.({});
      first.onmessage?.({ data: JSON.stringify({ type: "ready", cursor: "4" }) });
      first.onmessage?.({ data: JSON.stringify({ type: "event", event: { cursor: "5", type: "message.posted", board: "General", createdAt: "x", actor: root.by } }) });
      first.onmessage?.({ data: "{not json" });
      expect(seen).toEqual(["5"]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(first.sent).toContain(JSON.stringify({ type: "ping" }));
      first.onclose?.({});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(urls.at(-1)).toEqual({ board: "General", after: "5" });
      stop();
      expect(sockets.at(-1)!.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
