import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

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

describe("shell workspace CLI commands", () => {
  it("registers tab, pane, and layout namespaces", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "attach",
      "connect",
      "layout",
      "list",
      "ls",
      "new",
      "pane",
      "paste-clipboard",
      "paste-file",
      "paste-screenshot",
      "rm",
      "tab",
    ]);
  });

  it("emits JSON for tab, pane, and layout operations", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/terminal/sessions/main/tabs") && init?.method === "POST") {
        return new Response(JSON.stringify({ tab: { idx: 1, name: "api" } }));
      }
      if (url.endsWith("/api/terminal/sessions/main/panes") && init?.method === "POST") {
        return new Response(JSON.stringify({ pane: { paneId: "pane-2" } }));
      }
      if (url.endsWith("/api/terminal/layouts/dev") && init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.subCommands!.tab.subCommands!.new.run!({
      args: { session: "main", name: "api", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.pane.subCommands!.split.run!({
      args: { session: "main", direction: "right", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.layout.subCommands!.save.run!({
      args: { name: "dev", kdl: "layout {}", dev: true, token: "tok", json: true },
    } as never);

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { tab: { idx: 1, name: "api" } } },
      { v: 1, ok: true, data: { pane: { paneId: "pane-2" } } },
      { v: 1, ok: true, data: { ok: true } },
    ]);
  });

  it("rejects invalid tab indices before sending tab requests", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await shellCommand.subCommands!.tab.subCommands!.go.run!({
      args: { session: "main", tab: "abc", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.tab.subCommands!.close.run!({
      args: { session: "main", tab: "-1", dev: true, token: "tok", json: true },
    } as never);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      { v: 1, error: { code: "invalid_request", message: "Request failed" } },
      { v: 1, error: { code: "invalid_request", message: "Request failed" } },
    ]);
  });

  it("sends validated tab indices for tab switch and close", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await shellCommand.subCommands!.tab.subCommands!.go.run!({
      args: { session: "main", tab: "1", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.tab.subCommands!.close.run!({
      args: { session: "main", tab: "1", dev: true, token: "tok", json: true },
    } as never);

    expect(calls).toEqual([
      { url: "http://localhost:4000/api/terminal/sessions/main/tabs/1/go", method: "POST" },
      { url: "http://localhost:4000/api/terminal/sessions/main/tabs/1", method: "DELETE" },
    ]);
  });

  it("rejects invalid pane directions before sending split requests", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });

    await shellCommand.subCommands!.pane.subCommands!.split.run!({
      args: { session: "main", direction: "sideways", dev: true, token: "tok", json: true },
    } as never);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(errors[0]!)).toEqual({
      v: 1,
      error: { code: "invalid_request", message: "Request failed" },
    });
  });

  it("sends explicit and default pane directions", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ pane: { paneId: "pane-2" } }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await shellCommand.subCommands!.pane.subCommands!.split.run!({
      args: { session: "main", direction: "down", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.pane.subCommands!.split.run!({
      args: { session: "main", dev: true, token: "tok", json: true },
    } as never);

    expect(bodies).toEqual([
      { direction: "down" },
      { direction: "right" },
    ]);
  });
});
