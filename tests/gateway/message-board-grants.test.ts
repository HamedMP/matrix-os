import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardActor, BoardGrant } from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { MessageBoardServiceError } from "../../packages/gateway/src/message-board/errors.js";
import { resolveGrants } from "../../packages/gateway/src/message-board/grants.js";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes.js";
import { startMessageBoardRuntime, type MessageBoardRuntime } from "../../packages/gateway/src/message-board/runtime.js";
import type { BoardCaller } from "../../packages/gateway/src/message-board/service.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const owner: BoardActor = { id: "user:owner_1", kind: "user", name: "Owner" };
const guest: BoardActor = { id: "user:guest_1", kind: "user", name: "Guest" };
const ownerCaller: BoardCaller = { ownerId: "owner_1", actor: owner };
const guestCaller: BoardCaller = { ownerId: "owner_1", actor: guest, principal: "guest_1" };

function grant(principal: string, channel: string, permissions: BoardGrant["permissions"]): BoardGrant {
  return { id: `grt_${principal}${channel}`.replace(/[^A-Za-z0-9_]/g, "x"), principal, channel, permissions, createdBy: owner.id, createdAt: "x" };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (error instanceof MessageBoardServiceError) return error.reason;
    throw error;
  }
}

describe("grant resolution", () => {
  it("picks the most specific pattern, then the most specific principal, and adds grants at the same level", () => {
    const grants = [
      grant("*", "*", ["read"]),
      grant("*", "security/", ["read", "post"]),
      grant("user:guest_1", "security/", ["react"]),
      grant("*", "security/private", []),
      grant("user:guest_1", "security/private", ["read"]),
      grant("user:other", "security/private", ["read", "post"]),
    ];
    expect(resolveGrants(grants, ["user:guest_1"], "dev").permissions).toEqual(["read"]);
    expect(resolveGrants(grants, ["user:guest_1"], "security/findings")).toMatchObject({ pattern: "security/", permissions: ["react"] });
    expect(resolveGrants(grants, ["user:somebody"], "security/findings").permissions).toEqual(["read", "post"]);
    expect(resolveGrants(grants, ["user:somebody"], "security/private").permissions).toEqual([]);
    expect(resolveGrants(grants, ["user:guest_1"], "security/private").permissions).toEqual(["read"]);
    expect(resolveGrants([], ["user:x"], "dev")).toEqual({ pattern: null, permissions: ["read", "post", "react", "label"], grants: [] });
  });
});

describe("grants on the board", () => {
  let db: Kysely<MessageBoardDatabase>;
  let runtime: MessageBoardRuntime;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    runtime = await startMessageBoardRuntime(db, { timers: false });
  });

  afterEach(async () => {
    runtime.close();
    await db.destroy();
  });

  it("hides a private channel from others and refuses their reads and writes, while the owner keeps everything", async () => {
    const app = new Hono();
    let caller = ownerCaller;
    app.route("/api/board", createMessageBoardRoutes({
      service: runtime.service, tasks: runtime.tasks, hub: runtime.hub, resolveCaller: () => caller,
      automation: { watchers: runtime.watchers, schedules: runtime.schedules, grants: runtime.grants },
    }));
    const post = (path: string, body: unknown) => app.request(`/api/board${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/channels", { path: "security/private", private: true })).status).toBe(201);
    const secret = await runtime.service.post(ownerCaller, undefined, { channel: "security/private", text: "Rotate the key" });
    await runtime.service.post(ownerCaller, undefined, { channel: "dev", text: "Open work" });
    caller = guestCaller;
    const channels = await (await app.request("/api/board/channels")).json() as { channels: Array<{ path: string }> };
    expect(channels.channels.map((item) => item.path)).toEqual(["dev"]);
    const threads = await (await app.request("/api/board/threads")).json() as { threads: Array<{ root: { text: string } }> };
    expect(threads.threads.map((item) => item.root.text)).toEqual(["Open work"]);
    expect((await app.request(`/api/board/threads/${secret.id}`)).status).toBe(403);
    expect((await post("/messages", { channel: "security/private", text: "peek" })).status).toBe(403);
    expect((await post("/messages", { channel: "dev", text: "hello" })).status).toBe(201);
    const events = await (await app.request("/api/board/events?after=0")).json() as { events: Array<{ channel?: string }> };
    expect(events.events.some((event) => event.channel === "security/private")).toBe(false);
    expect((await app.request("/api/board/grants")).status).toBe(403);
    caller = ownerCaller;
    const explained = await (await app.request("/api/board/grants/explain?channel=security%2Fprivate&principal=user%3Aguest_1")).json() as { explanation: { permissions: string[]; source: string } };
    expect(explained.explanation).toMatchObject({ permissions: [], source: "grants" });
    // The owner's terminal agents are never narrowed by grants; the explanation says so.
    const agentView = await (await app.request("/api/board/grants/explain?channel=security%2Fprivate&principal=agent%3Atws_1.tt_1")).json() as { explanation: { permissions: string[]; source: string } };
    expect(agentView.explanation).toEqual(expect.objectContaining({ permissions: ["read", "post", "react", "label"], source: "owner" }));
    expect((await runtime.service.getThread(ownerCaller, undefined, secret.id)).root.text).toBe("Rotate the key");
  });

  it("lets the owner grant, change and remove access", async () => {
    await runtime.service.createChannel(ownerCaller, undefined, "ops");
    const [created] = await runtime.grants.create(ownerCaller, undefined, { principals: ["user:guest_1"], channel: "ops", permissions: ["read"] });
    expect(await reason(runtime.service.post(guestCaller, undefined, { channel: "ops", text: "x" }))).toBe("forbidden");
    await runtime.grants.patch(ownerCaller, undefined, created!.id, ["read", "post"]);
    await runtime.service.post(guestCaller, undefined, { channel: "ops", text: "now I can" });
    await runtime.grants.remove(ownerCaller, undefined, created!.id);
    expect(await runtime.grants.list(ownerCaller, undefined)).toEqual([]);
    // Fault detected (review): changes left no record of what access changed or who changed it.
    const audit = await db.selectFrom("board_events").select(["actor", "payload"]).where("type", "=", "grant.changed").orderBy("cursor").execute();
    expect(audit.map((row) => ({ by: (typeof row.actor === "string" ? JSON.parse(row.actor) : row.actor).id, ...(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) })))
      .toEqual([
        { by: owner.id, grant: created!.id, principal: "user:guest_1", pattern: "ops", permissions: ["read"], change: "set" },
        { by: owner.id, grant: created!.id, principal: "user:guest_1", pattern: "ops", permissions: ["read", "post"], change: "set" },
        { by: owner.id, grant: created!.id, principal: "user:guest_1", pattern: "ops", permissions: [], change: "removed" },
      ]);
    expect(await reason(runtime.grants.remove(ownerCaller, undefined, created!.id))).toBe("not_found");
  });
});
