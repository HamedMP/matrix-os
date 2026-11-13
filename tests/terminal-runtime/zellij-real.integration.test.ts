import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";
import { createTerminalRuntimeEnvironment } from "../../packages/terminal-runtime/src/runtime-environment.js";
import { initializeMatrixZellijConfig } from "../../packages/terminal-runtime/src/zellij-bootstrap.js";
import { matrixZellijConfigPaths } from "../../packages/terminal-runtime/src/zellij-config.js";

const execFileAsync = promisify(execFile);
const binaryPath = process.env.MATRIX_TEST_ZELLIJ_BIN ?? "/usr/local/bin/zellij";
let available = true;
try { await access(binaryPath); } catch { available = false; }

describe.runIf(available)("real bundled Zellij 0.44.3 integration", () => {
  let homePath = "";
  let sessionName = "";
  let adapter: ZellijCliRuntimeAdapter;
  let runtimeEnv: Record<string, string>;
  const extraSessionNames: string[] = [];

  beforeAll(async () => {
    const version = await execFileAsync(binaryPath, ["--version"], { timeout: 5_000 });
    expect(version.stdout.trim()).toBe("zellij 0.44.3");
    homePath = await mkdtemp(join(tmpdir(), "matrix-zellij-real-"));
    sessionName = `matrix-w-${randomBytes(16).toString("hex")}`;
    runtimeEnv = createTerminalRuntimeEnvironment({ homePath, uid: process.getuid?.() ?? 0, runtimeDir: homePath });
    adapter = new ZellijCliRuntimeAdapter({ homePath, binaryPath, env: runtimeEnv });
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
        env: runtimeEnv,
      }).catch(() => ({ stdout: "<dump failed>" }));
      reject(new Error(`observer did not receive targeted output; dump=${dump.stdout}; updates=${JSON.stringify(paneUpdates)}`));
    }, 15_000))]);
    await observer.close();

    expect(await adapter.findTabByInternalName(sessionName, firstName)).toEqual(first);
    await adapter.renameTab(sessionName, second.tabId, "renamed");
    expect(await adapter.findTabByInternalName(sessionName, secondName)).toBeUndefined();
    await expect(adapter.recoverRenamedTabs(sessionName, [{
      internalName: secondName, displayName: "renamed", tabId: second.tabId, paneId: second.paneId, requireLivePane: true,
    }])).resolves.toEqual({ [secondName]: second });
    expect(await adapter.findTabByInternalName(sessionName, secondName)).toEqual(second);
    await adapter.closeTab(sessionName, second.tabId);
    expect(await adapter.findTabByInternalName(sessionName, secondName)).toBeUndefined();
  }, 30_000);

  it("routes keyboard and terminal-emulator replies through the attached PTY", async () => {
    const internalName = `matrix-tab-${randomBytes(16).toString("hex")}`;
    const tab = await adapter.createTab(sessionName, { internalName, cwd: "", command: ["sh"] });
    let output = "";
    let attachmentExitCode: number | null | undefined;
    const commandObserved = Promise.withResolvers<void>();
    const paletteQueryObserved = Promise.withResolvers<void>();
    const attachment = await adapter.openAttachment(sessionName, {
      paneId: tab.paneId,
      size: { cols: 100, rows: 30 },
      onData: (data) => {
        output = `${output}${new TextDecoder().decode(data)}`.slice(-64 * 1024);
        if (output.split("matrix-pty-round-trip").length >= 3) commandObserved.resolve();
        if (output.includes("\x1b]10;?")) paletteQueryObserved.resolve();
      },
      onExit: (exitCode) => { attachmentExitCode = exitCode; },
    });

    await attachment.write(new TextEncoder().encode("printf 'matrix-pty-round-trip\\n'\r"));
    await Promise.race([
      commandObserved.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("attached PTY ignored keyboard input")), 10_000)),
    ]);
    await Promise.race([
      paletteQueryObserved.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Zellij emitted no OSC 10 query: ${JSON.stringify(output.slice(0, 4096))}`)), 2_000)),
    ]);
    expect(await adapter.findTabByInternalName(sessionName, internalName)).toEqual(tab);
    expect(attachmentExitCode).toBeUndefined();
    const oscReply = Buffer.from("\x1b]10;rgb:1111/2222/3333\x07", "latin1");
    await attachment.write(oscReply);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(await adapter.findTabByInternalName(sessionName, internalName)).toEqual(tab);
    expect(attachmentExitCode).toBeUndefined();
    const dump = await execFileAsync(binaryPath, [
      "--session", sessionName, "action", "dump-screen", "--pane-id", tab.paneId, "--full", "--ansi",
    ], {
      timeout: 5_000,
      env: runtimeEnv,
    });
    await attachment.close();

    expect(dump.stdout).not.toContain("rgb:1111/2222/3333");
  }, 30_000);

  it("keeps simultaneous PTY attachments bound to their requested panes", async () => {
    const firstName = `matrix-tab-${randomBytes(16).toString("hex")}`;
    const secondName = `matrix-tab-${randomBytes(16).toString("hex")}`;
    const first = await adapter.createTab(sessionName, { internalName: firstName, cwd: "", command: ["sh"] });
    const second = await adapter.createTab(sessionName, { internalName: secondName, cwd: "", command: ["sh"] });
    const firstMarker = `matrix-first-${randomBytes(8).toString("hex")}`;
    const secondMarker = `matrix-second-${randomBytes(8).toString("hex")}`;
    let firstOutput = "";
    let secondOutput = "";
    const firstReady = Promise.withResolvers<void>();
    const secondReady = Promise.withResolvers<void>();
    const firstAttachment = await adapter.openAttachment(sessionName, {
      paneId: first.paneId,
      size: { cols: 100, rows: 30 },
      onData: (data) => {
        firstOutput = `${firstOutput}${new TextDecoder().decode(data)}`.slice(-64 * 1024);
        if (firstOutput.includes(firstMarker)) firstReady.resolve();
      },
      onExit: firstReady.reject,
    });
    let secondAttachment: Awaited<ReturnType<typeof adapter.openAttachment>> | undefined;

    try {
      await firstAttachment.write(new TextEncoder().encode(`printf '${firstMarker}\\n'\r`));
      await Promise.race([
        firstReady.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first attachment ignored input")), 10_000)),
      ]);
      firstOutput = "";

      secondAttachment = await adapter.openAttachment(sessionName, {
        paneId: second.paneId,
        size: { cols: 100, rows: 30 },
        onData: (data) => {
          secondOutput = `${secondOutput}${new TextDecoder().decode(data)}`.slice(-64 * 1024);
          if (secondOutput.includes(secondMarker)) secondReady.resolve();
        },
        onExit: secondReady.reject,
      });
      await secondAttachment.write(new TextEncoder().encode(`printf '${secondMarker}\\n'\r`));
      await Promise.race([
        secondReady.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
          `second attachment was not bound to its pane; first=${JSON.stringify(firstOutput)} second=${JSON.stringify(secondOutput)}`,
        )), 10_000)),
      ]);

      const [firstDump, secondDump] = await Promise.all([first.paneId, second.paneId].map(async (paneId) => {
        const result = await execFileAsync(binaryPath, [
          "--session", sessionName, "action", "dump-screen", "--pane-id", paneId, "--full", "--ansi",
        ], { timeout: 5_000, env: runtimeEnv });
        return result.stdout;
      }));
      const liveSessions = await execFileAsync(binaryPath, ["list-sessions", "--no-formatting"], {
        timeout: 5_000,
        env: runtimeEnv,
      });

      expect(firstOutput).not.toContain(secondMarker);
      expect(secondOutput).toContain(secondMarker);
      expect(firstDump).toContain(firstMarker);
      expect(firstDump).not.toContain(secondMarker);
      expect(secondDump).toContain(secondMarker);
      expect(secondDump).not.toContain(firstMarker);
      expect(liveSessions.stdout).not.toContain("matrix-attach-");
    } finally {
      await secondAttachment?.close();
      await firstAttachment.close();
    }
  }, 30_000);

  it("keeps new held-pane attachments independent after upgrading a legacy config", async () => {
    const fixtureHome = await mkdtemp(join(tmpdir(), "matrix-zellij-held-"));
    const legacySession = `matrix-w-${randomBytes(16).toString("hex")}`;
    const fixtureSession = `matrix-w-${randomBytes(16).toString("hex")}`;
    const fixtureEnv = createTerminalRuntimeEnvironment({
      homePath: fixtureHome, uid: process.getuid?.() ?? 0, runtimeDir: fixtureHome,
    });
    const fixture = new ZellijCliRuntimeAdapter({ homePath: fixtureHome, binaryPath, env: fixtureEnv });
    const attachments: Awaited<ReturnType<typeof fixture.openAttachment>>[] = [];
    const outputs = ["", "", ""];
    const marker = `matrix-held-${randomBytes(8).toString("hex")}`;
    const command = async (...args: string[]) => (await execFileAsync(binaryPath,
      ["--session", fixtureSession, ...args], { timeout: 5_000, env: fixtureEnv })).stdout;
    try {
      await initializeMatrixZellijConfig(fixtureHome);
      const paths = matrixZellijConfigPaths(fixtureHome);
      const legacyConfig = (await readFile(new URL("./fixtures/legacy-mirrored-config.kdl", import.meta.url), "utf8"))
        .replace('"__MATRIX_SHELL_PATH__"', () => JSON.stringify(paths.shellFile));
      await writeFile(paths.file, legacyConfig);
      await fixture.ensureSession(legacySession, { cols: 100, rows: 30 });
      const legacyTab = await fixture.createTab(legacySession, {
        internalName: `matrix-tab-${randomBytes(16).toString("hex")}`, cwd: "",
        command: ["sh"],
      });

      await initializeMatrixZellijConfig(fixtureHome);
      await fixture.ensureSession(fixtureSession, { cols: 100, rows: 30 });
      await fixture.writeToPane(legacySession, legacyTab.paneId, new TextEncoder().encode("printf 'matrix-before-upgrade\\n'\r"));
      await expect.poll(async () => (await execFileAsync(binaryPath,
        ["--session", legacySession, "action", "dump-screen", "--pane-id", legacyTab.paneId, "--full", "--ansi"],
        { timeout: 5_000, env: fixtureEnv })).stdout).toContain("matrix-before-upgrade");
      const panes = [];
      for (let index = 0; index < 3; index += 1) {
        panes.push(await fixture.createTab(fixtureSession, {
          internalName: `matrix-tab-${randomBytes(16).toString("hex")}`, cwd: "",
          command: [process.execPath, "-e", `console.log('${marker}-${index}');process.exit(${index === 0 ? 0 : 3})`],
        }));
      }
      await expect.poll(async () => {
        const inventory = JSON.parse(await command("action", "list-panes", "--all", "--json"));
        return inventory.filter((pane: { is_plugin: boolean; is_held: boolean }) => !pane.is_plugin && pane.is_held).length;
      }).toBe(3);
      for (const [attachmentIndex, paneIndex] of [0, 2, 0].entries()) {
        attachments.push(await fixture.openAttachment(fixtureSession, {
          paneId: panes[paneIndex]!.paneId, size: { cols: 100, rows: 30 },
          onData: (data) => { outputs[attachmentIndex] = `${outputs[attachmentIndex]}${new TextDecoder().decode(data)}`.slice(-64 * 1024); },
          onExit: () => undefined,
        }));
        await expect.poll(() => outputs[attachmentIndex]).toContain(`${marker}-${paneIndex}`);
        if (attachmentIndex === 0) {
          await fixture.scrollState(fixtureSession, panes[0]!.paneId);
          const inventory = JSON.parse(await command("action", "list-panes", "--all", "--json"));
          const plugin = inventory.find((pane: { plugin_url?: string }) => pane.plugin_url?.endsWith("scroll-v1.wasm"));
          expect(plugin).toBeDefined();
          await command("action", "focus-pane-id", `plugin_${plugin.id}`);
          const focused = JSON.parse(await command("action", "list-panes", "--all", "--json"));
          expect(focused.find((pane: { id: number; is_plugin: boolean }) => pane.id === plugin.id && pane.is_plugin).is_focused).toBe(true);
        }
      }
      // Let any delayed mirrored redraw arrive before checking isolation.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(outputs[0]).not.toContain(`${marker}-2`);
      expect(outputs[1]).not.toContain(`${marker}-0`);
      expect(outputs[2]).not.toContain(`${marker}-2`);
      const clients = await command("action", "list-clients");
      expect(clients).toContain(panes[0]!.paneId);
      expect(clients).toContain(panes[2]!.paneId);
    } finally {
      for (const attachment of attachments.reverse()) await attachment.close();
      try { await Promise.all([fixture.deleteSession(fixtureSession), fixture.deleteSession(legacySession)]); }
      finally { await rm(fixtureHome, { recursive: true, force: true }); }
    }
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
