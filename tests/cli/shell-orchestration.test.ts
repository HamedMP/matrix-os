import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
const originalSession = process.env.ZELLIJ_SESSION_NAME;
const originalPane = process.env.ZELLIJ_PANE_ID;
const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";
const SESSION = `matrix-w-${"9".repeat(32)}`;

beforeEach(async () => {
  process.exitCode = undefined;
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-orchestration-"));
  roots.push(root);
  process.env.HOME = root;
  delete process.env.ZELLIJ_SESSION_NAME;
  delete process.env.ZELLIJ_PANE_ID;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalSession === undefined) delete process.env.ZELLIJ_SESSION_NAME; else process.env.ZELLIJ_SESSION_NAME = originalSession;
  if (originalPane === undefined) delete process.env.ZELLIJ_PANE_ID; else process.env.ZELLIJ_PANE_ID = originalPane;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function gateway(handler: (path: string, body: unknown) => Response) {
  const calls: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/coding-agents/summary") return json({ projects: { items: [{ id: "proj_0123456789abcdef", label: "app" }] } });
    if (path === "/api/terminal/workspaces") {
      return json({ workspaces: [
        { id: WORKSPACE_ID, scope: "main", tabs: [{ id: TAB_ID, name: "review", status: "running" }] },
        { id: "tws_00000000000000000000000000000002", scope: "project", projectId: "proj_0123456789abcdef", tabs: [] },
      ] });
    }
    if (path === "/api/terminal/templates") return json({ templates: [{ name: "reviewer", description: "Reviews" }] });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    return handler(path, body);
  }));
  return calls;
}

async function run(name: string, args: Record<string, unknown>) {
  const loader = (shellCommand.subCommands as Record<string, unknown>)[name] as () => Promise<{ run: (input: unknown) => Promise<void> }>;
  await (await loader()).run({ args: { dev: true, token: "tok", json: true, ...args } });
}

// Fault detected: an agent cannot delegate to a helper the way `hc run` does, or the
// helper's results never find their way back to the agent that started it.
describe("matrix shell orchestration", () => {
  it("runs a template with a task and the calling terminal as parent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.ZELLIJ_SESSION_NAME = SESSION;
    process.env.ZELLIJ_PANE_ID = "4";
    const calls = gateway(() => json({ tab: { id: TAB_ID, name: "review" }, firstMessage: { sent: true } }, 201));

    await run("run", { _: ["reviewer", "review", "src/x.ts"], label: ["role=review"] });

    expect(calls).toEqual([{ path: "/api/terminal/agents/run", body: {
      name: "reviewer", cwd: "", template: "reviewer", task: "review src/x.ts",
      caller: { sessionName: SESSION, paneId: "4" }, labels: { role: "review" },
    } }]);
  });

  it("runs a plain command as argv and honors --no-parent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.ZELLIJ_SESSION_NAME = SESSION;
    process.env.ZELLIJ_PANE_ID = "4";
    const calls = gateway(() => json({ tab: { id: TAB_ID } }, 201));
    await run("run", { _: ["bun", "test"], name: "tests", "no-parent": true });
    expect(calls[0]?.body).toEqual({ name: "tests", cwd: "", argv: ["bun", "test"], noParent: true });
  });

  it("says plainly when the first task was not sent", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));
    gateway(() => json({ tab: { id: TAB_ID, name: "review" }, firstMessage: { sent: false, reason: "blocked" } }, 201));
    await run("run", { _: ["reviewer", "go"], json: false });
    expect(logs[0]).toContain("Task NOT sent (blocked)");
  });

  it("reports to the parent from inside a Matrix terminal only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));
    const calls = gateway(() => json({ sent: true }));

    await run("report", { _: ["2 bugs"] });
    expect(calls).toEqual([]);
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "invalid_request" } });

    process.env.ZELLIJ_SESSION_NAME = SESSION;
    process.env.ZELLIJ_PANE_ID = "7";
    await run("report", { _: ["2 bugs", "in x.ts"] });
    expect(calls).toEqual([{ path: "/api/terminal/agents/report", body: { caller: { sessionName: SESSION, paneId: "7" }, text: "2 bugs in x.ts" } }]);
  });

  it("waits for children across server check-ins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.ZELLIJ_SESSION_NAME = SESSION;
    process.env.ZELLIJ_PANE_ID = "4";
    const replies = [{ reason: "timeout" }, { reason: "idle" }];
    const calls = gateway(() => json(replies.shift()));
    await run("wait-children", { _: ["all"], timeout: "600" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({ caller: { sessionName: SESSION, paneId: "4" }, mode: "all", timeoutMs: 90_000 });
  });

  // Fault detected (live check on the pr-3300 preview): the client dropped `reported` and
  // `exited`, so an agent could not tell a helper's report from its exit.
  it("says whether a helper reported or exited", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));
    process.env.ZELLIJ_SESSION_NAME = SESSION;
    process.env.ZELLIJ_PANE_ID = "4";
    const child = { workspaceId: WORKSPACE_ID, tabId: TAB_ID };
    const replies = [{ reason: "changed", child, reported: true }, { reason: "changed", child, exited: true }];
    gateway(() => json(replies.shift()));
    await run("wait-children", { _: ["any"] });
    await run("wait-children", { _: ["any"] });
    expect(logs.map((line) => JSON.parse(line).data)).toEqual([
      { reason: "changed", child, reported: true },
      { reason: "changed", child, exited: true },
    ]);
    logs.length = 0;
    replies.push({ reason: "changed", child, reported: true });
    await run("wait-children", { _: ["any"], json: false });
    expect(logs).toEqual(["changed (reported)"]);
  });

  it("labels and rejects malformed labels before any request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = gateway(() => json({ agent: {} }));
    await run("label", { tab: "review", _: ["Bad=1"] });
    expect(calls).toEqual([]);
    await run("label", { tab: "review", _: ["role=lead"], k: "old" });
    expect(calls).toEqual([{
      path: `/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ID}/labels`,
      body: { set: { role: "lead" }, remove: ["old"] },
    }]);
  });

  // Fault detected (second review of #3298): `run --project app -- bun test` ran in
  // home, and an explicit `--` command could be taken over by a same-named template.
  it("defaults to the project's folder and never treats a -- command as a template", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls = gateway(() => json({ tab: { id: TAB_ID } }, 201));
    const loader = (shellCommand.subCommands as Record<string, unknown>).run as () => Promise<{ run: (input: unknown) => Promise<void> }>;
    await (await loader()).run({
      args: { dev: true, token: "tok", json: true, project: "app", _: ["reviewer", "x"] },
      rawArgs: ["--project", "app", "--", "reviewer", "x"],
    });
    expect(calls.at(-1)?.body).toMatchObject({ projectId: "proj_0123456789abcdef", cwd: "projects/app", argv: ["reviewer", "x"] });
    expect(calls.at(-1)?.body).not.toHaveProperty("template");
  });
});
