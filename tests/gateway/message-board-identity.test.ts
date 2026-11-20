import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MATRIX_MCP_RUN_CONTEXT_KEY } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";
import { resolveBoardCaller } from "../../packages/gateway/src/message-board/caller.js";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { createMessageBoardKernelTools } from "../../packages/gateway/src/message-board/kernel-tools.js";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes.js";
import { startMessageBoardRuntime, type MessageBoardRuntime } from "../../packages/gateway/src/message-board/runtime.js";
import { isLocalTerminalAgentRoute } from "../../packages/gateway/src/terminal-agent/local-token.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const SESSION = `matrix-w-${"b".repeat(32)}`;

describe("board caller identity and permissions", () => {
  let db: Kysely<MessageBoardDatabase>;
  let runtime: MessageBoardRuntime;
  let app: Hono;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    runtime = await startMessageBoardRuntime(db);
    app = new Hono();
    app.use("*", async (c, next) => {
      setPlatformVerifiedPrincipal(c, "owner_1");
      markAuthContextReady(c);
      const run = c.req.header("x-test-run");
      if (run) c.set(MATRIX_MCP_RUN_CONTEXT_KEY as never, { actorId: "owner_1", runId: run, scope: "chat_call" } as never);
      await next();
    });
    app.route("/api/board", createMessageBoardRoutes({
      service: runtime.service, tasks: runtime.tasks, hub: runtime.hub,
      resolveCaller: (c) => resolveBoardCaller(c, {
        ownerName: "Owner",
        resolveTerminalCaller: async ({ sessionName, paneId }) => (sessionName === SESSION && paneId === "3"
          ? { workspaceId: "tws_1", tabId: "tt_9" } : undefined),
      }),
    }));
  });

  afterEach(async () => {
    runtime.close();
    await db.destroy();
  });

  const post = (headers: Record<string, string>, path = "/api/board/messages", body: unknown = { channel: "dev", text: "hello" }) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("attributes writes to the owner, a terminal tab, an unregistered pane, or a Chat Run", async () => {
    const by = async (headers: Record<string, string>) => ((await (await post(headers)).json()) as { message: { by: { id: string; kind: string } } }).message.by;
    expect(await by({})).toMatchObject({ id: "user:owner_1", kind: "user" });
    expect(await by({ "x-matrix-terminal-caller": `${SESSION}:3` })).toMatchObject({ id: "agent:tws_1.tt_9", kind: "agent" });
    expect(await by({ "x-matrix-terminal-caller": `${SESSION}:4` })).toMatchObject({ id: `agent:pane.${SESSION.slice(-12)}.4`, kind: "agent" });
    expect(await by({ "x-test-run": "run_abc123" })).toMatchObject({ id: "agent:run_run_abc123", kind: "agent" });
    expect((await post({ "x-matrix-terminal-caller": "not-a-pane" })).status).toBe(400);
  });

  it("keeps agent sessions to read, post, react and label", async () => {
    const agent = { "x-matrix-terminal-caller": `${SESSION}:3` };
    expect((await post(agent, "/api/board/boards", { name: "Agent board" })).status).toBe(403);
    expect((await post({}, "/api/board/boards", { name: "Owner board" })).status).toBe(201);
    const { message } = await (await post(agent)).json() as { message: { id: string } };
    expect((await post(agent, `/api/board/messages/${message.id}/reactions`, { emoji: "👀", on: true })).status).toBe(200);
    expect((await post(agent, "/api/board/tasks", { channel: "dev", text: "Task" })).status).toBe(201);
    expect((await app.request("/api/board/threads", { headers: agent })).status).toBe(200);
  });

  it("lets the local terminal token reach the board routes and nothing broader", () => {
    expect(isLocalTerminalAgentRoute("POST", "/api/board/messages")).toBe(true);
    expect(isLocalTerminalAgentRoute("POST", "/api/board/tasks/msg_abcdefgh12/complete")).toBe(true);
    expect(isLocalTerminalAgentRoute("PATCH", "/api/board/messages/msg_abcdefgh12/labels")).toBe(true);
    expect(isLocalTerminalAgentRoute("GET", "/api/board/events")).toBe(true);
    expect(isLocalTerminalAgentRoute("GET", "/api/board/../files")).toBe(false);
    expect(isLocalTerminalAgentRoute("PUT", "/api/board/messages")).toBe(false);
  });

  it("gives the kernel tools a fixed agent identity that model input cannot change", async () => {
    const tools = createMessageBoardKernelTools(runtime, "owner_1");
    const posted = await tools.post({ channel: "dev", text: "From Matrix", profile: "triage" }) as { id: string; by: { id: string; profile?: string } };
    expect(posted.by).toMatchObject({ id: "agent:matrix", profile: "triage" });
    await tools.reply({ id: posted.id, text: "More" });
    const created = await tools.taskCreate({ channel: "dev", text: "Do it" }) as { root: { id: string } };
    const claim = await tools.taskClaim({ ready: "dev" }) as { taskId: string; epoch: number; token: string };
    expect(claim.taskId).toBe(created.root.id);
    await tools.taskSettle({ id: claim.taskId, epoch: claim.epoch, token: claim.token, outcome: "complete", text: "Done" });
    const thread = await tools.read({ target: created.root.id }) as { task: { state: string; result: string } };
    expect(thread.task).toMatchObject({ state: "completed", result: "Done" });
    const page = await tools.wait({ after: "0", timeoutSeconds: 1 }) as { events: unknown[] };
    expect(page.events.length).toBeGreaterThan(0);
    expect(() => createMessageBoardKernelTools(runtime, "")).toThrow();
  });
});
