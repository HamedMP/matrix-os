import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MatrixRequestError,
  MatrixUnauthorizedError,
  SYNC_FILTER,
  createBridgeMatrixClient,
} from "../../../packages/gateway/src/messages/bridge-matrix-client.js";

const session = {
  homeserverUrl: "https://bridge.example.test",
  userId: "@mx_owner:bridge.example.test",
  accessToken: "syt_secret_access_token_value",
  deviceId: "MATRIXOSGW",
  networks: ["whatsapp" as const],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bridge Matrix client", () => {
  it("long-polls sync with a filter that limits timelines and drops presence, typing and receipts", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => json(200, { next_batch: "s2", rooms: { join: {} } }));
    const matrix = createBridgeMatrixClient({ fetchImpl });

    await expect(matrix.sync(session, { since: "s1", timeoutMs: 30_000 })).resolves.toMatchObject({ next_batch: "s2" });

    const [rawUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe("https://bridge.example.test/_matrix/client/v3/sync");
    expect(url.searchParams.get("since")).toBe("s1");
    expect(url.searchParams.get("timeout")).toBe("30000");
    const filter = JSON.parse(url.searchParams.get("filter") ?? "{}");
    expect(filter).toEqual(SYNC_FILTER);
    expect(filter.room.timeline.limit).toBe(50);
    expect(filter.presence.not_types).toEqual(["*"]);
    expect(filter.room.ephemeral.not_types).toEqual(["*"]);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${session.accessToken}`);
    expect(timeoutSpy).toHaveBeenCalledWith(35_000);
  });

  it("sends text with the caller's transaction id as an idempotent PUT", async () => {
    const fetchImpl = vi.fn(async () => json(200, { event_id: "$sent1" }));
    const matrix = createBridgeMatrixClient({ fetchImpl });

    await expect(matrix.sendText(session, { roomId: "!abc:bridge.example.test", txnId: "txn_12345678", body: "hello" }))
      .resolves.toEqual({ eventId: "$sent1" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bridge.example.test/_matrix/client/v3/rooms/!abc%3Abridge.example.test/send/m.room.message/txn_12345678");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ msgtype: "m.text", body: "hello" });
  });

  it("raises a typed unauthorized error on a rejected token without echoing it", async () => {
    const fetchImpl = vi.fn(async () => json(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token passed." }));
    const error = await createBridgeMatrixClient({ fetchImpl }).getRoomState(session, "!abc:bridge.example.test").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MatrixUnauthorizedError);
    expect(String((error as Error).message)).not.toContain(session.accessToken);
  });

  it("classifies retryable and permanent homeserver failures", async () => {
    const cases: Array<[Response | Error, boolean]> = [
      [json(429, { errcode: "M_LIMIT_EXCEEDED" }), true],
      [json(502, {}), true],
      [new TypeError("fetch failed"), true],
      [json(403, { errcode: "M_FORBIDDEN" }), false],
      [json(404, { errcode: "M_NOT_FOUND" }), false],
    ];
    for (const [result, retryable] of cases) {
      const fetchImpl = vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      const error = await createBridgeMatrixClient({ fetchImpl }).joinRoom(session, "!abc:bridge.example.test").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MatrixRequestError);
      expect((error as MatrixRequestError).retryable).toBe(retryable);
    }
  });

  it("refuses a session whose homeserver is not plain https", async () => {
    const fetchImpl = vi.fn();
    const matrix = createBridgeMatrixClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(matrix.sync({ ...session, homeserverUrl: "http://bridge.example.test" }, { timeoutMs: 0 })).rejects.toBeInstanceOf(MatrixRequestError);
    await expect(matrix.sync({ ...session, homeserverUrl: "https://u:p@bridge.example.test" }, { timeoutMs: 0 })).rejects.toBeInstanceOf(MatrixRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed sync payloads", async () => {
    const fetchImpl = vi.fn(async () => json(200, { rooms: {} }));
    await expect(createBridgeMatrixClient({ fetchImpl }).sync(session, { timeoutMs: 0 })).rejects.toMatchObject({ retryable: true });
  });

  it("keeps a limited timeline's prev_batch so the caller can fill the gap", async () => {
    const fetchImpl = vi.fn(async () => json(200, {
      next_batch: "s3",
      rooms: { join: { "!abc:bridge.example.test": { timeline: { events: [], limited: true, prev_batch: "t_prev" } } } },
    }));
    const response = await createBridgeMatrixClient({ fetchImpl }).sync(session, { since: "s2", timeoutMs: 0 });
    expect(response.rooms?.join?.["!abc:bridge.example.test"]?.timeline).toEqual({ events: [], limited: true, prev_batch: "t_prev" });
  });

  it("pages room history backwards between two tokens with a timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => json(200, {
      chunk: [{ type: "m.room.message", event_id: "$e1", sender: "@a:x", origin_server_ts: 1, content: { msgtype: "m.text", body: "hi" } }],
      start: "t_prev",
      end: "t_older",
      state: [{ type: "m.room.member", state_key: "@a:x", content: { membership: "join", displayname: "Ann" } }],
    }));
    const page = await createBridgeMatrixClient({ fetchImpl }).getMessages(session, {
      roomId: "!abc:bridge.example.test", from: "t_prev", to: "s2", limit: 100,
    });
    expect(page.chunk.map((event) => event.event_id)).toEqual(["$e1"]);
    expect(page.end).toBe("t_older");
    expect(page.state).toHaveLength(1);

    const [rawUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/_matrix/client/v3/rooms/!abc%3Abridge.example.test/messages");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ dir: "b", from: "t_prev", to: "s2", limit: "100" });
    expect(JSON.parse(url.searchParams.get("filter") ?? "{}")).toEqual({ lazy_load_members: true });
    expect(init.redirect).toBe("error");
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);

    const empty = vi.fn(async () => json(200, { chunk: [], start: "t_prev" }));
    await expect(createBridgeMatrixClient({ fetchImpl: empty }).getMessages(session, { roomId: "!abc:bridge.example.test", from: "t_prev", limit: 100 }))
      .resolves.toEqual({ chunk: [], state: [] });
  });
});
