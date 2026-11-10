import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(import.meta.dirname, "../../..");
const hasDesktopBuild = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasDesktopBuild) {
  throw new Error("Required Desktop E2E build is missing");
}
const suite = hasDesktopBuild && process.platform !== "win32" ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
// Evidence stays outside the repository tree that git tracks.
const output = process.env.MATRIX_TERMINAL_WINDOW_EVIDENCE_DIR ?? join(tmpdir(), "matrix-terminal-window-evidence");

// Local terminals need the pinned herdr-core binary. CI provides it and sets
// MATRIX_DESKTOP_HC_REQUIRED=1; elsewhere the local tests run when it is installed.
const hcPath = [process.env.MATRIX_DESKTOP_HC_PATH, join(homedir(), ".local/bin/hc")].find((candidate) => {
  try { return !!candidate && execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 3_000 }).trim().endsWith("0.1.19"); }
  catch { return false; }
});
if (process.env.MATRIX_DESKTOP_HC_REQUIRED === "1" && !hcPath) throw new Error("herdr-core 0.1.19 is required for this lane");
const localIt = hcPath ? it : it.skip;

suite("Electron Desktop Terminal window", () => {
  let app: ElectronApplication, main: Page, terminal: Page, gateway: StubGateway, profile: string;
  let launch: () => Promise<ElectronApplication>;
  let coreEnv: Record<string, string> | null = null;
  let runtimeDir = "";
  const hc = (...args: string[]) => execFileSync(hcPath!, args, { env: coreEnv!, encoding: "utf8", timeout: 10_000 });
  const terminalPages = () => app.windows().filter((page) => page.url().includes("window=terminal"));

  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    gateway = await startStubGateway();
    profile = mkdtempSync(join(tmpdir(), "matrix-terminal-window-"));
    launch = () => _electron.launch({ executablePath, args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile,
        ...(hcPath ? { MATRIX_DESKTOP_HC_PATH: hcPath } : {}) } });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electronApp, safeStorage }) => {
      await electronApp.whenReady();
      return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000,
        userId: "user-1", handle: "neo" })).toString("base64");
    });
    writeFileSync(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app);
    app = await launch();
    main = await app.firstWindow();
    await main.getByRole("button", { name: "Terminal window", exact: true }).waitFor({ timeout: 30_000 });
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    runtimeDir = join(homedir(), ".matrixos", "dt", createHash("sha256").update(userData).digest("hex").slice(0, 8));
    coreEnv = { HOME: homedir(), PATH: "/usr/bin:/bin", HC_SESSION: "mx", XDG_STATE_HOME: join(userData, "herdr/state"),
      XDG_CONFIG_HOME: join(userData, "herdr/config"), XDG_RUNTIME_DIR: runtimeDir };
  }, 90_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    // The local core outlives the app by design, so the test ends it itself.
    if (hcPath && coreEnv && existsSync(join(runtimeDir, "herdr-core/mx.sock"))) {
      try {
        for (const item of JSON.parse(hc("ls", "--json")).terminals as Array<{ address: string }>) hc("kill", item.address);
        hc("server", "stop");
      } catch (error: unknown) { console.error("local core cleanup failed", error instanceof Error ? error.name : error); }
    }
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("opens one Terminal window from the top bar, even for concurrent requests", async () => {
    const opened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Terminal window", exact: true }).click();
    await main.evaluate(() => Promise.all([
      window.operator.invoke("terminal-window:open", {}),
      window.operator.invoke("terminal-window:open", {}),
    ]));
    terminal = await opened;
    await terminal.getByRole("heading", { name: "Terminals across your computers" }).waitFor();
    expect(terminalPages()).toHaveLength(1);
    expect(app.windows()).toHaveLength(2);
  });

  it("lists This Computer and every Matrix computer without changing the main selection", async () => {
    const machines = terminal.getByRole("navigation", { name: "Machines" });
    await expect.poll(() => machines.getByRole("listitem").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(await machines.getByRole("listitem").first().getAttribute("data-machine")).toBe("local");
    await machines.getByText("Main Computer").waitFor();
    expect(gateway.state.runtimeSelections).toEqual([]);
    await terminal.screenshot({ path: join(output, "electron-terminal-window.png") });
    await main.screenshot({ path: join(output, "electron-top-bar-launcher.png") });
  });

  it("lists a computer's terminals and attaches one with that computer's credential", async () => {
    const machines = terminal.getByRole("navigation", { name: "Machines" });
    await machines.getByRole("button", { name: /Main Computer/ }).click();
    const tab = machines.getByRole("button", { name: /matrix-task-1/ });
    await tab.waitFor({ timeout: 15_000 });
    await tab.click();
    // The stub only upgrades a socket that carries the computer's bearer, which
    // this window's renderer never holds: the trusted core attached it.
    await terminal.locator(".xterm").first().waitFor({ timeout: 15_000 });
    await expect.poll(() => gateway.state.terminalResizeEvents.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await terminal.locator(".xterm-helper-textarea").first().focus();
    await terminal.keyboard.type("echo terminal-window");
    await expect.poll(() => gateway.state.terminalInputs.join(""), { timeout: 10_000 }).toContain("echo terminal-window");
    expect(await terminal.evaluate(() => document.cookie)).toBe("");
    expect(await main.evaluate(() => window.operator.invoke("auth:status", {}).then((status) => status.runtimeSlot))).toBe("primary");
    expect(gateway.state.runtimeSelections).toEqual([]);
    await terminal.screenshot({ path: join(output, "electron-terminal-window-attached.png") });
  });

  it("keeps privileged channels away from the Terminal window in both the preload and the main process", async () => {
    const blocked = await terminal.evaluate(async () => {
      const attempt = (channel: string, payload: unknown) => window.operator.invoke(channel, payload)
        .then(() => "allowed", (error: Error) => error.message);
      return {
        signOut: await attempt("auth:sign-out", {}),
        select: await attempt("runtime:select", { slot: "review" }),
        stateSet: await attempt("state:set", { key: "recents", value: [] }),
        open: await attempt("terminal-window:open", {}),
        status: await attempt("auth:status", {}),
      };
    });
    expect(blocked).toEqual({ signOut: "unknown channel", select: "unknown channel", stateSet: "unknown channel",
      open: "unknown channel", status: "allowed" });
    // The main process refuses the same channels even with the preload out of
    // the picture: the registered handlers are called directly, as each window.
    const refused = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const windows = BrowserWindow.getAllWindows();
      const terminalWin = windows.find((candidate) => candidate.webContents.getURL().includes("window=terminal"))!;
      const mainWin = windows.find((candidate) => candidate !== terminalWin)!;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: unknown) => unknown> })._invokeHandlers;
      const call = (win: typeof mainWin, channel: string, payload: unknown) => Promise.resolve()
        .then(() => handlers.get(channel)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, payload))
        .then(() => "allowed", (error: Error) => error.message);
      return {
        terminalSignOut: await call(terminalWin, "auth:sign-out", {}),
        terminalSelect: await call(terminalWin, "runtime:select", { slot: "review" }),
        terminalStateSet: await call(terminalWin, "state:set", { key: "recents", value: [] }),
        terminalOtherState: await call(terminalWin, "state:get", { key: "recents" }),
        terminalAppearance: await call(terminalWin, "state:get", { key: "appearance" }),
        terminalStatus: await call(terminalWin, "auth:status", {}),
        mainFocusMain: await call(mainWin, "terminal-window:focus-main", {}),
        mainStatus: await call(mainWin, "auth:status", {}),
      };
    });
    expect(refused).toEqual({
      terminalSignOut: "invalid request", terminalSelect: "invalid request", terminalStateSet: "invalid request",
      terminalOtherState: "invalid request", terminalAppearance: "allowed", terminalStatus: "allowed",
      mainFocusMain: "invalid request", mainStatus: "allowed",
    });
    const mainSide = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("window=terminal"))!;
      return {
        partition: win.webContents.session.storagePath !== BrowserWindow.getAllWindows()
          .find((candidate) => candidate !== win)!.webContents.session.storagePath,
        sandboxed: win.webContents.getLastWebPreferences()?.sandbox === true,
      };
    });
    expect(mainSide).toEqual({ partition: true, sandboxed: true });
    expect(await main.evaluate(() => window.operator.invoke("terminal-window:focus-main", {})
      .then(() => "allowed", (error: Error) => error.message))).toBe("unknown channel");
    expect(gateway.state.runtimeSelections).toEqual([]);
  });

  localIt("runs a local terminal privately and keeps it running across an app restart", async () => {
    const localList = () => terminal.getByRole("list", { name: "This Computer terminals" });
    await localList().getByRole("button", { name: "New terminal" }).click();
    await terminal.locator(".xterm").first().waitFor({ timeout: 15_000 });
    await expect.poll(() => (JSON.parse(hc("ls", "--json")).terminals as unknown[]).length, { timeout: 15_000 }).toBe(1);
    const [{ address }] = JSON.parse(hc("ls", "--json")).terminals as Array<{ address: string }>;
    await terminal.locator(".xterm-helper-textarea").first().focus();
    await terminal.keyboard.type("echo LOCAL_$((6*7)); env | grep -c -E '^(MATRIX_|OPERATOR_|ELECTRON_|XDG_|HC_)'; echo ENV_CHECKED");
    await terminal.keyboard.press("Enter");
    // Wait for the command's output lines, not the echoed command itself.
    const outputLines = () => hc("read", address).split("\n").map((line) => line.trim());
    await expect.poll(outputLines, { timeout: 15_000 }).toContain("ENV_CHECKED");
    const lines = outputLines();
    expect(lines).toContain("LOCAL_42");
    // grep -c prints 0: none of the app's or the core's variables reached the shell.
    expect(lines.slice(lines.indexOf("LOCAL_42"), lines.indexOf("ENV_CHECKED") + 1)).toEqual(["LOCAL_42", "0", "ENV_CHECKED"]);
    // Nothing local went to the gateway.
    expect(gateway.state.terminalInputs.join("")).not.toContain("LOCAL_");
    await terminal.screenshot({ path: join(output, "electron-terminal-window-local.png") });

    await closeElectronApp(app);
    expect((JSON.parse(hc("ls", "--json")).terminals as Array<{ address: string; state: string }>)
      .filter((item) => item.state === "live").map((item) => item.address)).toEqual([address]);
    app = await launch();
    main = await app.firstWindow();
    const reopened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Terminal window", exact: true }).click({ timeout: 30_000 });
    terminal = await reopened;
    await expect.poll(() => localList().getByRole("button", { name: /^(?!New terminal|End )/ }).count(), { timeout: 15_000 }).toBe(1);
    await localList().getByRole("button", { name: /^(?!New terminal|End )/ }).click();
    await terminal.locator(".xterm").first().waitFor({ timeout: 15_000 });
    await terminal.locator(".xterm-helper-textarea").first().focus();
    await terminal.keyboard.type("echo AGAIN_$((2+3))");
    await terminal.keyboard.press("Enter");
    await expect.poll(outputLines, { timeout: 15_000 }).toContain("AGAIN_5");
  }, 120_000);

  it("closes without closing the main window and restores its bounds on reopen", async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("window=terminal"))!;
      win.setBounds({ x: 120, y: 90, width: 940, height: 610 });
    });
    await new Promise((done) => setTimeout(done, 900));
    await terminal.close();
    await expect.poll(() => app.windows().length).toBe(1);
    expect(main.isClosed()).toBe(false);
    const reopened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Terminal window", exact: true }).click();
    terminal = await reopened;
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().includes("window=terminal"))!.getBounds());
    expect(bounds).toMatchObject({ width: 940, height: 610 });
  });
});
