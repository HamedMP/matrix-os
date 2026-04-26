import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-cli-"));
  roots.push(root);
  process.env.HOME = root;
  return root;
}

beforeEach(async () => {
  await tempHome();
});

afterEach(async () => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell CLI command", () => {
  it("exports the shell command namespace", () => {
    expect(shellCommand.meta?.name).toBe("shell");
  });

  it("registers ls, new, attach, and rm session subcommands", () => {
    expect(Object.keys(shellCommand.subCommands ?? {}).sort()).toEqual([
      "attach",
      "ls",
      "new",
      "rm",
    ]);
  });

  it("emits versioned JSON for ls, new, and rm", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "main", created: true }), { status: 201 });
      }
      if (url.endsWith("/api/sessions/main")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({ sessions: [{ name: "main" }] }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    await shellCommand.subCommands!.ls.run!({
      args: { dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.new.run!({
      args: { name: "main", dev: true, token: "tok", json: true },
    } as never);
    await shellCommand.subCommands!.rm.run!({
      args: { name: "main", dev: true, token: "tok", json: true },
    } as never);

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { v: 1, ok: true, data: { sessions: [{ name: "main" }] } },
      { v: 1, ok: true, data: { name: "main", created: true } },
      { v: 1, ok: true, data: { ok: true } },
    ]);
  });
});
