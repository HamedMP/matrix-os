import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalAgentStatusIndex } from "../../packages/terminal-runtime/src/agent-status.js";

const run = promisify(execFile);
const script = resolve(__dirname, "../../distro/customer-vps/host-bin/matrix-status");
const session = `matrix-w-${"d".repeat(32)}`;
const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"1".repeat(32)}`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function report(home: string, args: string[], env: Record<string, string> = {}) {
  return run("/bin/sh", [script, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MATRIX_HOME: home, ZELLIJ_SESSION_NAME: session, ZELLIJ_PANE_ID: "5", ...env },
  });
}

function index(home: string) {
  return createTerminalAgentStatusIndex({
    homePath: home,
    store: {
      listWorkspaces: async () => [{ id: workspaceId }],
      getRuntimeWorkspace: async () => ({
        zellijSessionName: session,
        tabs: { [tabId]: { status: "running", zellijPaneId: "terminal_5" } },
      }),
    },
  });
}

// Fault detected: a program's `matrix-status` report never reaches its tab because the
// shell writer and the runtime reader disagree on path or format.
describe("matrix-status reporter", () => {
  it("reports a status the runtime index reads for the right tab", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-status-"));
    roots.push(home);
    await report(home, ["blocked", 'Allow "rm"?', "\\ path"]);
    await expect(index(home).list()).resolves.toEqual([expect.objectContaining({
      ref: { workspaceId, tabId },
      status: "blocked",
      message: 'Allow "rm"? \\ path',
      source: "reporter",
    })]);
    await report(home, ["done"]);
    await expect(index(home).list()).resolves.toEqual([expect.objectContaining({ status: "done" })]);
    expect((await readdir(join(home, "system", "terminal-status", session))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects unknown words with usage and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-status-"));
    roots.push(home);
    await expect(report(home, ["dancing"])).rejects.toMatchObject({ code: 2 });
    await expect(index(home).list()).resolves.toEqual([]);
  });

  it("is a silent no-op outside a Matrix terminal or with a malformed pane id", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-status-"));
    roots.push(home);
    await expect(report(home, ["working"], { ZELLIJ_SESSION_NAME: "my-own-zellij" })).resolves.toBeDefined();
    await expect(report(home, ["working"], { ZELLIJ_PANE_ID: "../../x" })).resolves.toBeDefined();
    await expect(readdir(join(home, "system"))).rejects.toThrow();
  });

  // Fault detected: a predictable temporary name lets another file or link be overwritten.
  it("never writes through a file planted at a predictable temporary path", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-status-"));
    roots.push(home);
    const dir = join(home, "system", "terminal-status", session);
    await mkdir(dir, { recursive: true });
    const victim = join(home, "victim.txt");
    await writeFile(victim, "keep");
    for (let pid = 1; pid < 64; pid += 1) await symlink(victim, join(dir, `.terminal_5.${pid}.tmp`)).catch(() => undefined);
    await report(home, ["working"]);
    expect(await readFile(victim, "utf8")).toBe("keep");
    await expect(index(home).list()).resolves.toEqual([expect.objectContaining({ status: "working" })]);
    const left = (await readdir(dir)).filter((name) => name.endsWith(".tmp") && !/^\.terminal_5\.\d+\.tmp$/.test(name));
    expect(left).toEqual([]);
  });
});
