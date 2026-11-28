import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createManagedTerminalBroker, createManagedTerminalPickerRoutes, managedTerminalBrokerFromEnv } from "../../packages/gateway/src/chat/managed-terminal-source.js";
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
  it("uses only the configured canary for terminal calls and stops at the canary deadline", async () => {
    const now = 1_790_000_000_000;
    const candidate = "https://tc-d6bc5cf---matrix-platform-hash-ew.a.run.app";
    const env = {
      MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED: "1",
      MATRIX_CLERK_USER_ID: "user_test",
      MATRIX_MACHINE_ID: "71085f3e-9453-4ecd-9e4a-531d0905dd3c",
      MATRIX_RUNTIME_SLOT: "primary",
      MATRIX_SYNC_RUNTIME_TOKEN: token,
      PLATFORM_INTERNAL_URL: "https://platform.test",
      MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_ORIGIN: candidate,
      MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_EXPIRES_AT: String(now + 1000),
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ computers: [], partial: false }));
    let clock = now;
    const opts = { now: () => clock, fetch: fetcher };
    const broker = managedTerminalBrokerFromEnv(env, opts);
    await expect(broker?.computers()).resolves.toEqual({ computers: [], partial: false });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(candidate + "/internal/terminal-control");
    expect(managedTerminalBrokerFromEnv({ ...env, MATRIX_RUNTIME_SLOT: "dev" }, opts)).toBeNull();
    expect(managedTerminalBrokerFromEnv({ ...env, MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_ORIGIN: "https://tc-d6bc5cf---matrix-platform-hash.run.app.example.com" }, opts)).toBeNull();
    clock = now + 1000;
    await expect(broker?.computers()).rejects.toThrow("Managed terminal candidate expired");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(managedTerminalBrokerFromEnv(env, opts)).toBeNull();
  });

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
