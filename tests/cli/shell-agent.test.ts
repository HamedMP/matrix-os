import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellCommand } from "../../packages/sync-client/src/cli/commands/shell.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";
const TAB_PATH = `/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ID}`;

beforeEach(async () => {
  process.exitCode = undefined;
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-agent-cli-"));
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

function gateway(verbResponse: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/coding-agents/summary")) return json({ projects: { items: [] } });
    if (url.endsWith("/api/terminal/workspaces")) {
      return json({ workspaces: [{ id: WORKSPACE_ID, scope: "main", tabs: [{ id: TAB_ID, name: "review", status: "running" }] }] });
    }
    calls.push({ url, ...(init ? { init } : {}) });
    return verbResponse(url, init);
  }));
  return calls;
}

async function run(name: "read" | "send" | "keys" | "interrupt" | "get", args: Record<string, unknown>) {
  const loader = shellCommand.subCommands![name] as unknown as () => Promise<{ run: (input: unknown) => Promise<void> }>;
  const command = await loader();
  await command.run({ args: { dev: true, token: "tok", json: true, tab: "review", ...args } });
}

// Fault detected: an agent following `hc --skill` habits in a Matrix terminal cannot
// read a helper's output or steer it from the CLI.
describe("matrix shell agent verbs", () => {
  it("reads a named tab's screen and history by line count", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => logs.push(String(line)));
    const calls = gateway(() => json({ screen: "$ ", history: "4 passed", lines: 1 }));

    await run("read", { lines: "40" });

    expect(calls[0]?.url).toMatch(`${TAB_PATH}/read?lines=40`);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      ok: true,
      data: { terminalRef: { workspaceId: WORKSPACE_ID, tabId: TAB_ID }, screen: "$ ", history: "4 passed" },
    });
  });

  it("sends positional text with force only when asked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls = gateway(() => json({ sent: true, heldMs: 0 }));

    await run("send", { _: ["recheck", "the", "fix"] });
    await run("send", { _: ["yes"], force: true });

    expect(calls.map((call) => [call.url.replace(/^.*\/api/, "/api"), call.init?.method, call.init?.body])).toEqual([
      [`${TAB_PATH}/send`, "POST", JSON.stringify({ text: "recheck the fix" })],
      [`${TAB_PATH}/send`, "POST", JSON.stringify({ text: "yes", force: true })],
    ]);
  });

  it("explains a blocked agent instead of a generic failure", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));
    gateway(() => json({ error: "terminal_agent_blocked" }, 409));

    await run("send", { _: ["yes"] });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "terminal_agent_blocked" } });
  });

  it("does not leak unknown server error strings", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));
    gateway(() => json({ error: "postgres said /home/matrix/secret" }, 500));

    await run("keys", { _: ["enter"] });

    expect(errors[0]).not.toContain("secret");
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "request_failed" } });
  });

  it("validates line counts before any request", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => errors.push(String(line)));
    const calls = gateway(() => json({}));

    await run("read", { lines: "lots" });

    expect(calls).toEqual([]);
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "invalid_request" } });
  });
});
