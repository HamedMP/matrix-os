import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createManagedTerminalBroker, createManagedTerminalPickerRoutes } from "../../packages/gateway/src/chat/managed-terminal-source.js";
import { createHerdrChatTerminalRoute } from "../../packages/gateway/src/chat/herdr-terminal-route.js";
import { MATRIX_MCP_RUN_CONTEXT_KEY } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { createManagedTerminalVerifier } from "@matrix-os/contracts/managed-terminal-proof";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const ownerId = "user_test";
const identity = { machineId: "origin", ownerId, runtimeSlot: "dev" };
const tabId = "tt_" + "a".repeat(32);
const revision = "b".repeat(64);
const token = "ab".repeat(32);
const authority = { proof: "test." + "a".repeat(64), clientRequestId: "managed_test_turn", bodyDigest: "9".repeat(64) };

function fixture() {
  const verify = createManagedTerminalVerifier({ direction: "source" });
  const calls: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const raw = String(init?.body);
    expect(verify(new Request(url, init), token, raw)).not.toBeNull();
    const body = JSON.parse(raw);
    expect(body.source).toEqual(identity);
    calls.push(body.request);
    if (body.request.kind === "computers") {
      return Response.json({ computers: [{ machineId: "target", name: "QA Computer", runtimeSlot: "test" }], partial: false });
    }
    if (body.request.kind === "terminals") {
      return Response.json({ status: "ready", available: true, sessions: [
        { id: "t1", tabId, title: "eng495-worktree", status: "idle", revision },
      ] });
    }
    return Response.json({ result: { screen: "ENG495 EXIT=0", history: "", lines: 0 } });
  });
  const broker = createManagedTerminalBroker({ origin: "https://platform.test", identity, token, fetch });
  return { broker, calls, fetch };
}

describe("managed terminal control source", () => {
  it("lists target terminals for the exact runtime owner, without opening a run", async () => {
    const { broker, calls } = fixture();
    let principal = { source: "jwt", userId: "someone-else" } satisfies RequestPrincipal;
    const app = createManagedTerminalPickerRoutes({ broker, principal: () => principal, ownerIds: [ownerId] });
    expect((await app.request("/")).status).toBe(404);
    expect(calls).toEqual([]);
    principal = { ...principal, userId: ownerId };
    const list = await (await app.request("/")).json();
    expect(list.computers[0]).toMatchObject({ name: "QA Computer", workspaceId: expect.stringMatching(/^tws_6d6774/) });
    expect((await (await app.request("/?machine=target")).json()).sessions[0].revision).toBe(revision);
    expect(calls).toEqual([{ kind: "computers" }, { kind: "terminals", targetMachineId: "target" }]);
  });

  it("only sends the registered run target with no paired desktop and discards replies after Stop", async () => {
    const { broker, calls } = fixture();
    const [peer] = (await broker.computers()).computers;
    const stopped = new AbortController();
    let actorId = ownerId;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set(MATRIX_MCP_RUN_CONTEXT_KEY as never, {
        actorId, runId: "run_a", scope: "chat_herdr", herdr: {
          chatId: "chat_a", worktreeId: "wt_a", executionRoot: "/source/checkout",
          ref: { workspaceId: peer!.workspaceId, tabId }, revision, authority, signal: stopped.signal,
        },
      } as never);
      await next();
    });
    app.route("/", createHerdrChatTerminalRoute(null, { lastInputAt: () => undefined } as never, null, broker));
    const read = () => app.request("/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read", lines: 30 }),
    });
    const result = await read();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ runId: "run_a", result: { screen: "ENG495 EXIT=0" } });
    expect(calls.at(-1)).toEqual({
      kind: "action", targetMachineId: "target", chatId: "chat_a", runId: "run_a", worktreeId: "wt_a",
      ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId }, revision, authority, action: { action: "read", lines: 30 },
    });
    actorId = "unknown";
    expect((await read()).status).toBe(403);
    actorId = ownerId;
    stopped.abort();
    expect((await read()).status).toBe(403);
    expect(calls.filter(call => (call as { kind: string }).kind === "action")).toHaveLength(1);
  });
});
