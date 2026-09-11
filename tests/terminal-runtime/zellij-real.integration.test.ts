import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";

const execFileAsync = promisify(execFile);
const binaryPath = process.env.MATRIX_TEST_ZELLIJ_BIN ?? "/usr/local/bin/zellij";
let available = true;
try { await access(binaryPath); } catch { available = false; }

describe.runIf(available)("real bundled Zellij 0.44.3 integration", () => {
  let homePath = "";
  let sessionName = "";
  let adapter: ZellijCliRuntimeAdapter;
  const extraSessionNames: string[] = [];

  beforeAll(async () => {
    const version = await execFileAsync(binaryPath, ["--version"], { timeout: 5_000 });
    expect(version.stdout.trim()).toBe("zellij 0.44.3");
    homePath = await mkdtemp(join(tmpdir(), "matrix-zellij-real-"));
    sessionName = `matrix-w-${randomBytes(16).toString("hex")}`;
    adapter = new ZellijCliRuntimeAdapter({ homePath, binaryPath });
    await adapter.ensureSession(sessionName, { cols: 100, rows: 30 });
  }, 20_000);

  afterAll(async () => {
    await Promise.all(extraSessionNames.map((name) => adapter?.deleteSession(name).catch(() => undefined)));
    await adapter?.deleteSession(sessionName).catch(() => undefined);
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  it("keeps structured tab/pane IDs stable across targeted input, observation, and reconciliation", async () => {
    const firstName = `matrix-tab-${randomBytes(16).toString("hex")}`;
    const secondName = `matrix-tab-${randomBytes(16).toString("hex")}`;
    const first = await adapter.createTab(sessionName, { internalName: firstName, cwd: "", command: ["sh"] });
    const second = await adapter.createTab(sessionName, { internalName: secondName, cwd: "", command: ["sh"] });
    expect(first.tabId).not.toBe(second.tabId);
    expect(first.paneId).toMatch(/^terminal_\d+$/);

    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    let observedResolve!: () => void;
    const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
    const paneUpdates: string[] = [];
    const observer = await adapter.subscribeWorkspace(sessionName, {
      paneIds: [first.paneId, second.paneId],
      onEvent: (event) => {
        if (event.type !== "pane-update") return;
        paneUpdates.push(`${event.paneId}:${event.ansi}`);
        readyResolve();
        if (event.paneId === first.paneId && event.ansi.includes("matrix-targeted-input")) observedResolve();
      },
    });
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("observer did not become ready")), 10_000)),
    ]);
    await adapter.writeToPane(sessionName, first.paneId, new TextEncoder().encode("printf 'matrix-targeted-input\\n'\r"));
    await Promise.race([observed, new Promise<never>((_, reject) => setTimeout(async () => {
      const dump = await execFileAsync(binaryPath, ["--session", sessionName, "action", "dump-screen", "--pane-id", first.paneId, "--full", "--ansi"], {
        timeout: 5_000,
        env: { ...process.env, HOME: homePath, MATRIX_HOME: homePath, ZELLIJ_CONFIG_DIR: join(homePath, "system", "zellij") },
      }).catch(() => ({ stdout: "<dump failed>" }));
      reject(new Error(`observer did not receive targeted output; dump=${dump.stdout}; updates=${JSON.stringify(paneUpdates)}`));
    }, 15_000))]);
    await observer.close();

    expect(await adapter.findTabByInternalName(sessionName, firstName)).toEqual(first);
    await adapter.renameTab(sessionName, second.tabId, "renamed");
    await adapter.closeTab(sessionName, second.tabId);
    expect(await adapter.findTabByInternalName(sessionName, secondName)).toBeUndefined();
  }, 30_000);

  it("uses one substantially smaller Zellij server for 23 idle tabs", async () => {
    const denseSession = `matrix-w-${randomBytes(16).toString("hex")}`;
    extraSessionNames.push(denseSession);
    await adapter.ensureSession(denseSession, { cols: 100, rows: 30 });
    for (let index = 0; index < 23; index += 1) {
      await adapter.createTab(denseSession, {
        internalName: `matrix-tab-${randomBytes(16).toString("hex")}`,
        cwd: "",
        command: ["sh"],
      });
    }

    const denseServers = await zellijServerRss([denseSession]);
    expect(denseServers).toHaveLength(1);

    const separateSessions = Array.from({ length: 23 }, () => `matrix-w-${randomBytes(16).toString("hex")}`);
    extraSessionNames.push(...separateSessions);
    for (const name of separateSessions) {
      await adapter.ensureSession(name, { cols: 100, rows: 30 });
      await adapter.createTab(name, {
        internalName: `matrix-tab-${randomBytes(16).toString("hex")}`,
        cwd: "",
        command: ["sh"],
      });
    }

    const separateServers = await zellijServerRss(separateSessions);
    expect(separateServers).toHaveLength(23);
    expect(denseServers[0]).toBeLessThan(separateServers.reduce((total, rss) => total + rss, 0) * 0.5);
  }, 120_000);
});

async function zellijServerRss(sessionNames: string[]): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "rss=,args="], { timeout: 5_000 });
  return stdout.split("\n").flatMap((line) => {
    if (!sessionNames.some((name) => line.includes(name))) return [];
    const rss = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? "", 10);
    return Number.isFinite(rss) ? [rss * 1024] : [];
  });
}
