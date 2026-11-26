import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";

beforeEach(async () => {
  process.exitCode = undefined;
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-cli-"));
  roots.push(root);
  process.env.HOME = root;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("shell CLI command", () => {
  it("exports the project-scoped shell namespace", () => {
    expect(shellCommand.meta).toMatchObject({ name: "shell" });
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "connect", "get", "interrupt", "keys", "label", "list", "ls", "machine", "new", "read", "report", "rm", "run", "send",
      "templates", "wait", "wait-children",
    ]);
  });

  it("prints current usage for the bare shell command", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));
    await shellCommand.run?.({ args: {}, rawArgs: [] } as never);
    expect(logs).toEqual([
      "Usage: matrix shell list|new|connect|rm|run|get|read|send|keys|interrupt|wait|wait-children|label|report|templates|machine [--project <project>] [--tab <tab>]",
    ]);
  });

  it("fails before fetch when profile auth is missing", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await shellCommand.subCommands!.list.run!({ args: { dev: true, json: true } } as never);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(errors[0]!)).toMatchObject({ v: 1, error: { code: "not_authenticated" } });
  });

  it("prints a herdr section after the Matrix tabs when the computer has Herdr sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return json({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [{
        id: WORKSPACE_ID, scope: "main", tabs: [{ id: TAB_ID, name: "Shell", cwd: "", status: "running" }],
      }] });
      if (url.endsWith("/api/terminal/herdr")) return json({ available: true, status: "ready", sessions: [
        { id: "t3", tabId: `tt_${"3".repeat(32)}`, title: "claude", status: "blocked", statusMessage: "Allow edit?" },
        { id: "t4", tabId: `tt_${"4".repeat(32)}`, title: "build", status: null },
      ] });
      throw new Error(`unexpected request ${url}`);
    }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));

    await shellCommand.subCommands!.list.run!({ args: { dev: true, token: "tok" } } as never);

    expect(logs).toEqual([
      "main:",
      `  ${TAB_ID}  Shell  running`,
      "herdr:",
      "  t3  claude  blocked  Allow edit?",
      "  t4  build",
    ]);
  });

  it("shows no herdr section when the gateway has no Herdr sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return json({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [] });
      if (url.endsWith("/api/terminal/herdr")) return json({ available: false, status: "not-installed", sessions: [] });
      throw new Error(`unexpected request ${url}`);
    }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));
    await shellCommand.subCommands!.list.run!({ args: { dev: true, token: "tok" } } as never);
    expect(logs).toEqual(["No terminal tabs."]);
  });

  it("keeps listing Matrix tabs and reports a safe error kind when the Herdr request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return json({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [{
        id: WORKSPACE_ID, scope: "main", tabs: [{ id: TAB_ID, name: "Shell", cwd: "", status: "running" }],
      }] });
      if (url.endsWith("/api/terminal/herdr")) throw new Error("connect ECONNREFUSED /home/matrix/secret.sock");
      throw new Error(`unexpected request ${url}`);
    }));
    const logs: string[] = [];
    const warnings: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));
    vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => warnings.push(parts.map(String).join(" ")));

    await shellCommand.subCommands!.list.run!({ args: { dev: true, token: "tok" } } as never);

    expect(logs).toEqual(["main:", `  ${TAB_ID}  Shell  running`]);
    expect(process.exitCode).toBeUndefined();
    expect(warnings).toEqual(["Herdr sessions unavailable (gateway_unreachable)"]);
  });

  it("emits versioned JSON grouped by workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return json({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [{
        id: WORKSPACE_ID,
        scope: "main",
        tabs: [{ id: TAB_ID, name: "Shell", cwd: "", status: "running" }],
      }] });
      throw new Error(`unexpected request ${url}`);
    }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));

    await shellCommand.subCommands!.ls.run!({ args: { dev: true, token: "tok", json: true } } as never);

    expect(JSON.parse(logs[0]!)).toEqual({ v: 1, ok: true, data: { workspaces: [{
      id: WORKSPACE_ID,
      scope: "main",
      tabs: [{ id: TAB_ID, name: "Shell", cwd: "", status: "running" }],
    }] } });
  });

  it("does not expose removed session attach or native pane commands", () => {
    expect(shellCommand.subCommands).not.toHaveProperty("attach");
    expect(shellCommand.subCommands).not.toHaveProperty("pane");
    expect(shellCommand.subCommands).not.toHaveProperty("layout");
    expect(shellCommand.subCommands).not.toHaveProperty("tab");
  });

  it("requires an explicit tab when connecting", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return json({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [{ id: WORKSPACE_ID, scope: "main", tabs: [] }] });
      throw new Error(`unexpected request ${url}`);
    }));

    await shellCommand.subCommands!.connect.run!({ args: { dev: true, token: "tok", json: true } } as never);

    expect(JSON.parse(errors[0]!)).toEqual({ v: 1, error: { code: "invalid_request", message: "--tab is required" } });
  });
});
