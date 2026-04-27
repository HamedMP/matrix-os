import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-workspace-cli-"));
  roots.push(root);
  process.env.HOME = root;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell workspace CLI commands", () => {
  it("registers tab, pane, and layout namespaces", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "attach",
      "layout",
      "ls",
      "new",
      "pane",
      "rm",
      "tab",
    ]);
  });

  it("emits JSON for tab, pane, and layout operations", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/sessions/main/tabs") && init?.method === "POST") {
        return new Response(JSON.stringify({ tab: { idx: 1, name: "api" } }));
      }
      if (url.endsWith("/api/sessions/main/panes") && init?.method === "POST") {
        return new Response(JSON.stringify({ pane: { paneId: "pane-2" } }));
      }
      if (url.endsWith("/api/layouts/dev") && init?.method === "PUT") {
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
});
