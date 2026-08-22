import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mainWorkspace(tabs: unknown[] = []) {
  return { id: WORKSPACE_ID, scope: "main", tabs };
}

beforeEach(async () => {
  process.exitCode = undefined;
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-workspace-cli-"));
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

describe("project-scoped shell CLI commands", () => {
  it("exposes only workspace/tab commands and removes native zellij pane commands", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "connect",
      "list",
      "ls",
      "new",
      "rm",
    ]);
  });

  it("lists terminal tabs grouped by workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return response({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) {
        return response({ workspaces: [mainWorkspace([{ id: TAB_ID, name: "Shell", status: "running", cwd: "projects" }])] });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));

    await shellCommand.subCommands!.list.run!({ args: { dev: true, token: "tok" } } as never);

    expect(logs).toEqual(["main:", `  ${TAB_ID}  Shell  running  projects`]);
  });

  it("creates a tab in the ensured main workspace", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/api/coding-agents/summary")) return response({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces") && !init?.method) return response({ workspaces: [] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return response({ workspace: mainWorkspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`)) return response({ tab: { id: TAB_ID, name: "Build", cwd: "" } });
      throw new Error(`unexpected request ${url}`);
    }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));

    await shellCommand.subCommands!.new.run!({ args: { name: "Build", dev: true, token: "tok", json: true } } as never);

    expect(calls).toContainEqual({ url: `http://localhost:4000/api/terminal/workspaces/${WORKSPACE_ID}/tabs`, body: { name: "Build", cwd: "" } });
    expect(JSON.parse(logs[0]!)).toEqual({ v: 1, ok: true, data: { terminalRef: { workspaceId: WORKSPACE_ID, tabId: TAB_ID }, tab: { id: TAB_ID, name: "Build", cwd: "" } } });
  });

  it("resolves a named project to its single workspace", async () => {
    const projectId = "proj_0000000000000001";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/api/coding-agents/summary")) return response({ projects: { items: [{ id: projectId, label: "matrix-os" }] } });
      if (url.endsWith("/api/terminal/workspaces") && !init?.method) return response({ workspaces: [{ ...mainWorkspace(), scope: "project", projectId }] });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`)) return response({ tab: { id: TAB_ID, name: "Shell" } });
      throw new Error(`unexpected request ${url}`);
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await shellCommand.subCommands!.new.run!({ args: { project: "matrix-os", dev: true, token: "tok" } } as never);

    expect(calls).toContain(`http://localhost:4000/api/terminal/workspaces/${WORKSPACE_ID}/tabs`);
  });

  it("terminates only the selected tab", async () => {
    const deleteRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/coding-agents/summary")) return response({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces") && !init?.method) return response({ workspaces: [mainWorkspace([{ id: TAB_ID, name: "Build" }])] });
      if (init?.method === "DELETE") {
        deleteRequests.push(url);
        return response({ ok: true });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await shellCommand.subCommands!.rm.run!({ args: { project: "main", tab: "Build", dev: true, token: "tok" } } as never);

    expect(deleteRequests).toEqual([`http://localhost:4000/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ID}`]);
  });

  it("rejects ambiguous display names and requires a stable tab id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/coding-agents/summary")) return response({ projects: { items: [] } });
      if (url.endsWith("/api/terminal/workspaces")) return response({ workspaces: [mainWorkspace([
        { id: TAB_ID, name: "Build" },
        { id: "tt_00000000000000000000000000000002", name: "Build" },
      ])] });
      throw new Error(`unexpected request ${url}`);
    }));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));

    await shellCommand.subCommands!.rm.run!({ args: { project: "main", tab: "Build", dev: true, token: "tok", json: true } } as never);

    expect(JSON.parse(errors[0]!)).toEqual({ v: 1, error: { code: "invalid_request", message: "Tab name is ambiguous; use its tab id" } });
  });
});
