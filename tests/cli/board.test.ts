import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoardCli } from "../../packages/sync-client/src/cli/commands/board.js";
import { parseBoardDuration } from "../../packages/sync-client/src/cli/board-cli-support.js";
import { boardError, cleanupHomes, harness, json, PANE_ENV, REPLY_ID, ROOT_ID } from "./board-harness.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id, channel: "build", text: "hello", re: null, replyTo: null,
  by: { id: "agent:a1", kind: "agent", name: "claude" }, labels: {}, reactions: [], revision: 1,
  createdAt: "2026-11-20T10:00:00.000Z", ...extra,
});

// Fault detected: an agent in a Matrix terminal cannot post, read or label board
// messages from the CLI, or its writes are attributed to the wrong actor.
describe("matrix board read of one thread", () => {
  // Fault detected (review): reading a thread cut the root and replies to their first line,
  // so a task's instructions or a person's answer could disappear from the output.
  it("prints every line of the root, the replies and the task outcome", async () => {
    const long = "x".repeat(150);
    const h = await harness(() => json({ thread: {
      root: message(ROOT_ID, { text: `Fix it ${long}\nstep two\nstep three` }),
      replies: [message(REPLY_ID, { text: "first line\nsecond line of the answer" })],
      task: { state: "completed", result: `Merged #3501 ${long}` }, needs: [],
    } }));
    expect(await runBoardCli(["read", ROOT_ID], h.deps)).toBe(0);
    const output = h.out.join("\n");
    expect(output).toContain(long);
    expect(output).toContain("step three");
    expect(output).toContain("second line of the answer");
    expect(output).toContain(`result: Merged #3501 ${long}`);
  });
});

describe("matrix board message verbs", () => {
  it("posts with labels, an idempotency key and a profile", async () => {
    const h = await harness(() => json({ message: message(ROOT_ID) }, 201));

    const code = await runBoardCli(
      ["post", "build", "ship", "it", "--label", "pr=12", "--label", "area=cli", "--idempotency-key", "k1", "--as", "reviewer", "--board", "Ops"],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      method: "POST", path: "/api/board/messages", query: { board: "Ops" },
      body: { channel: "build", text: "ship it", labels: { pr: "12", area: "cli" }, idempotencyKey: "k1", profile: "reviewer" },
    });
    expect(h.calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(h.out.join("\n")).toContain(ROOT_ID);
  });

  it("sends the terminal caller header only when calling from inside a Matrix terminal", async () => {
    const inside = await harness(() => json({ actor: { id: "agent:a1", kind: "agent", name: "claude" } }), { env: PANE_ENV, local: true });
    await runBoardCli(["whoami"], inside.deps);
    expect(inside.calls[0]!.headers["x-matrix-terminal-caller"]).toBe(`${PANE_ENV.ZELLIJ_SESSION_NAME}:7`);

    const outside = await harness(() => json({ actor: { id: "user:u1", kind: "user", name: "me" } }));
    await runBoardCli(["whoami"], outside.deps);
    expect(outside.calls[0]!.headers).not.toHaveProperty("x-matrix-terminal-caller");

    // A signed-in profile chosen inside a pane speaks for the profile, not the pane's agent.
    const profile = await harness(() => json({ actor: { id: "user:u1", kind: "user", name: "me" } }), { env: PANE_ENV, local: false });
    await runBoardCli(["whoami"], profile.deps);
    expect(profile.calls[0]!.headers).not.toHaveProperty("x-matrix-terminal-caller");
  });

  it("replies in the thread's channel, naming the message replied to", async () => {
    const h = await harness((call) => call.method === "GET"
      ? json({ thread: { root: message(ROOT_ID, { channel: "security/scan" }), replies: [], task: null, needs: [] } })
      : json({ message: message(REPLY_ID) }, 201));

    expect(await runBoardCli(["reply", ROOT_ID, "on", "it"], h.deps)).toBe(0);

    expect(h.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", `/api/board/threads/${ROOT_ID}`],
      ["POST", "/api/board/messages"],
    ]);
    expect(h.calls[1]!.body).toEqual({ channel: "security/scan", text: "on it", re: ROOT_ID });
  });

  it("reads a channel's threads with filters, a thread by ID, and mentions as messages", async () => {
    const h = await harness((call) => {
      if (call.path.startsWith("/api/board/threads/")) {
        return json({ thread: { root: message(ROOT_ID), replies: [message(REPLY_ID, { re: ROOT_ID })], task: { state: "claimed", needs: [] }, needs: [] } });
      }
      if (call.path === "/api/board/messages") return json({ messages: [message(REPLY_ID)] });
      return json({ threads: [{ root: message(ROOT_ID), replyCount: 2, latestReply: null, lastActivityAt: "x", task: null, unread: false }] });
    });

    await runBoardCli(["read", "build", "--by", "agent:a1", "--label", "pr=12", "--text", "ship", "--limit", "10"], h.deps);
    await runBoardCli(["read", ROOT_ID], h.deps);
    await runBoardCli(["read", "build", "--mentions", "reviewer"], h.deps);
    await runBoardCli(["read"], h.deps);

    expect(h.calls.map((call) => [call.path, call.query])).toEqual([
      ["/api/board/threads", { channel: "build", by: "agent:a1", label: "pr=12", text: "ship", limit: "10" }],
      [`/api/board/threads/${ROOT_ID}`, {}],
      ["/api/board/messages", { channel: "build", mentions: "reviewer" }],
      ["/api/board/threads", {}],
    ]);
    expect(h.out.join("\n")).toContain("claimed");
  });

  it("labels with compare-and-set, reacts, edits and deletes", async () => {
    const h = await harness((call) => call.method === "PATCH" && call.path.endsWith(ROOT_ID)
      ? json({ message: message(ROOT_ID, { revision: 2 }) })
      : json({ ok: true }));

    await runBoardCli(["label", ROOT_ID, "status=done", "owner=me", "--unset", "wip", "--if", "status=open", "--if-unset", "lock"], h.deps);
    await runBoardCli(["react", ROOT_ID, ":+1:"], h.deps);
    await runBoardCli(["react", ROOT_ID, ":+1:", "--remove"], h.deps);
    await runBoardCli(["edit", ROOT_ID, "new", "text"], h.deps);
    await runBoardCli(["delete", ROOT_ID], h.deps);

    expect(h.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PATCH", `/api/board/messages/${ROOT_ID}/labels`, { set: { status: "done", owner: "me" }, unset: ["wip"], if: { status: "open" }, ifUnset: ["lock"] }],
      ["POST", `/api/board/messages/${ROOT_ID}/reactions`, { emoji: ":+1:", on: true }],
      ["POST", `/api/board/messages/${ROOT_ID}/reactions`, { emoji: ":+1:", on: false }],
      ["PATCH", `/api/board/messages/${ROOT_ID}`, { text: "new text" }],
      ["DELETE", `/api/board/messages/${ROOT_ID}`, {}],
    ]);
  });

  it("lists channels, actors and boards", async () => {
    const h = await harness((call) => {
      if (call.path.endsWith("/channels")) return json({ channels: [{ path: "build", unread: 1, threadCount: 4, lastActivityAt: null }] });
      if (call.path.endsWith("/actors")) return json({ actors: [{ id: "agent:a1", kind: "agent", name: "claude" }] });
      return json({ boards: [{ id: "brd_00000001", name: "General", scope: "personal" }] });
    });
    await runBoardCli(["channels"], h.deps);
    await runBoardCli(["actors"], h.deps);
    await runBoardCli(["boards", "--json"], h.deps);
    expect(h.calls.map((call) => call.path)).toEqual(["/api/board/channels", "/api/board/actors", "/api/board/boards"]);
    expect(h.out[0]).toContain("build");
    expect(h.out[1]).toContain("agent:a1");
    expect(JSON.parse(h.out[2]!)).toMatchObject({ ok: true, data: { boards: [{ name: "General" }] } });
  });

  it("prints one JSON document with the board's reason and next step on failure", async () => {
    const h = await harness(() => boardError("rate_limited", 429, "Too many writes. Try again shortly.", "retry after a minute"));

    const code = await runBoardCli(["post", "build", "hi", "--json"], h.deps);

    expect(code).toBe(1);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual({
      v: 1, ok: false, reason: "rate_limited", error: "Too many writes. Try again shortly.", next: "retry after a minute",
    });
  });

  it("never prints unknown server error text", async () => {
    const h = await harness(() => json({ error: "relation board_messages: /home/matrix/secret" }, 500));
    const code = await runBoardCli(["post", "build", "hi"], h.deps);
    expect(code).toBe(1);
    expect([...h.out, ...h.err].join("\n")).not.toContain("secret");
  });

  it("exits 2 on usage errors without calling the gateway", async () => {
    const h = await harness(() => json({}));
    expect(await runBoardCli(["post", "build"], h.deps)).toBe(2);
    expect(await runBoardCli(["post", "build", "hi", "--label", "noequals"], h.deps)).toBe(2);
    expect(await runBoardCli(["post", "build", "hi", "--as", "1bad"], h.deps)).toBe(2);
    expect(await runBoardCli(["frobnicate"], h.deps)).toBe(2);
    expect(await runBoardCli(["read", "build", "--bogus"], h.deps)).toBe(2);
    expect(await runBoardCli(["edit", "not-an-id", "x", "--json"], h.deps)).toBe(2);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: false, reason: "usage" });
    expect(h.calls).toHaveLength(0);
  });

  it("maps an unreachable gateway and an expired login to their reasons", async () => {
    const down = await harness(() => { throw new TypeError("fetch failed"); });
    expect(await runBoardCli(["channels", "--json"], down.deps)).toBe(1);
    expect(JSON.parse(down.out[0]!)).toMatchObject({ reason: "gateway_unreachable" });

    const expired = await harness(() => json({ error: "Unauthorized" }, 401));
    expect(await runBoardCli(["channels", "--json"], expired.deps)).toBe(1);
    expect(JSON.parse(expired.out[0]!)).toMatchObject({ reason: "auth_expired" });
  });
});

describe("board durations", () => {
  it("parses seconds, minutes and hours and rejects anything else", () => {
    expect(parseBoardDuration("30s")).toBe(30_000);
    expect(parseBoardDuration("5m")).toBe(300_000);
    expect(parseBoardDuration("2h")).toBe(7_200_000);
    expect(parseBoardDuration("45")).toBe(45_000);
    for (const bad of ["", "5x", "-1m", "1.5h", "25h", "m"]) {
      expect(() => parseBoardDuration(bad), bad).toThrow();
    }
  });
});

describe("matrix board wait and tail", () => {
  it("re-polls with the server's cursor until a matching event arrives, then prints the next cursor", async () => {
    const event = { cursor: "42", type: "message.posted", board: "General", createdAt: "x", actor: { id: "agent:a1", kind: "agent", name: "c" }, channel: "build", messageId: REPLY_ID, threadId: ROOT_ID };
    const pages = [
      { events: [], cursor: "40" },
      { events: [], cursor: "41" },
      { events: [event], cursor: "44" },
    ];
    const h = await harness(() => json(pages.shift()));

    const code = await runBoardCli(["wait", ROOT_ID, "--after", "39", "--json"], h.deps);

    expect(code).toBe(0);
    expect(h.calls.map((call) => call.query)).toEqual([
      { after: "39", wait: "25", thread: ROOT_ID },
      { after: "40", wait: "25", thread: ROOT_ID },
      { after: "41", wait: "25", thread: ROOT_ID },
    ]);
    // The event's own cursor, so a following wait sees anything after it.
    expect(JSON.parse(h.out[0]!)).toMatchObject({ ok: true, data: { event: { cursor: "42" }, cursor: "42" } });
  });

  it("waits on a channel from now when no cursor is given", async () => {
    const h = await harness(() => json({ events: [{ cursor: "7", type: "task.ready", board: "General", createdAt: "x", actor: { id: "system:s", kind: "system", name: "s" }, channel: "build" }], cursor: "7" }));
    expect(await runBoardCli(["wait", "build"], h.deps)).toBe(0);
    expect(h.calls[0]!.query).toEqual({ wait: "25", channel: "build" });
    expect(h.out.join("\n")).toContain("--after 7");
  });

  it("exits 1 with reason timeout and the cursor to resume from", async () => {
    vi.useFakeTimers({ now: 0 });
    const h = await harness(() => {
      vi.advanceTimersByTime(25_000);
      return json({ events: [], cursor: "9" });
    });

    const code = await runBoardCli(["wait", "build", "--timeout", "1m", "--json"], h.deps);

    expect(code).toBe(1);
    expect(h.calls.map((call) => call.query.wait)).toEqual(["25", "25", "10"]);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ ok: false, reason: "timeout", cursor: "9" });
  });

  it("tails events as they arrive and exits 130 on interrupt", async () => {
    const handlers = new Map<string, () => void>();
    const signals = { on: (name: string, fn: () => void) => void handlers.set(name, fn), off: (name: string) => void handlers.delete(name) };
    let polls = 0;
    const h = await harness(async () => {
      polls += 1;
      if (polls === 1) return json({ events: [{ cursor: "5", type: "message.posted", board: "General", createdAt: "x", actor: { id: "agent:a1", kind: "agent", name: "c" }, channel: "build", messageId: ROOT_ID }], cursor: "5" });
      handlers.get("SIGINT")?.();
      throw new DOMException("aborted", "AbortError");
    });

    const code = await runBoardCli(["tail", "build", "--after", "4"], { ...h.deps, signals });

    expect(code).toBe(130);
    expect(h.calls.map((call) => call.query.after)).toEqual(["4", "5"]);
    expect(h.out.join("\n")).toContain("message.posted");
    expect(handlers.size).toBe(0);
  });
});
