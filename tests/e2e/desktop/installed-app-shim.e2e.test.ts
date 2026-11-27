// macOS only: installs an app as a real app-shim bundle through the installer,
// launches it with `open`, and checks that the running Electron Desktop
// verifies it and gives it its own Dock identity (spec 2711 acceptance 1, 3).
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication } from "playwright";
import { appShimServerName, shimBundleFiles } from "../../../desktop/src/main/installed-apps/mac-bundle";
import { detectMacShimHost, readCdHashes, runTool, type MacShimHost } from "../../../desktop/src/main/installed-apps/mac-host";
import { buildShimIcon } from "../../../desktop/src/main/installed-apps/mac-icon";
import { createMacInstaller } from "../../../desktop/src/main/installed-apps/mac-installer";
import { createInstalledAppStore } from "../../../desktop/src/main/installed-apps/record-store";
import type { InstalledAppRecord } from "../../../desktop/src/main/installed-apps/record";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const hasDesktopBuild = existsSync(join(root, "desktop/out/main/index.js"));
const suite = hasDesktopBuild && process.platform === "darwin" ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;

/** `lsappinfo` lists apps registered with the Dock; it needs no Automation permission. */
async function runningApp(bundleId: string): Promise<{ name: string; foreground: boolean } | null> {
  const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", "-only", "applicationType", "-app", bundleId]);
  const name = /"LSDisplayName"="([^"]*)"/.exec(stdout)?.[1];
  return name ? { name, foreground: stdout.includes('"Foreground"') } : null;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((settle) => setTimeout(settle, 250));
  }
}

suite("Electron Desktop installed app shims (macOS)", () => {
  let app: ElectronApplication;
  let gateway: StubGateway;
  let profile: string;
  let work: string;
  let host: MacShimHost;
  let record: InstalledAppRecord;
  const logs: string[] = [];
  const appsDir = () => join(work, "Matrix Apps");
  const records = () => createInstalledAppStore({ dir: profile });
  const installer = () => createMacInstaller({
    appsDir: appsDir(),
    records: records(),
    host: { ...host, serverName: appShimServerName({ channel: "dev" }) },
    makeIcon: async () => buildShimIcon({
      png: new Uint8Array(readFileSync(join(root, "desktop/build/icon.png"))),
      fallbackIcnsPath: host.fallbackIcnsPath, execFile: runTool, tmpDir: join(work, "icons"),
    }),
    readCdHashes: (path) => readCdHashes(runTool, path),
    forgetWindowState: async () => undefined,
  });

  const launch = async () => {
    app = await _electron.launch({
      executablePath,
      args: [join(root, "desktop/out/main/index.js"), "--use-mock-keychain"],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    const capture = (chunk: Buffer) => { logs.push(chunk.toString()); };
    app.process().stdout?.on("data", capture);
    app.process().stderr?.on("data", capture);
    await app.firstWindow();
  };

  const appWindowTitles = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed()).map((win) => win.getTitle()));

  beforeAll(async () => {
    gateway = await startStubGateway({ installedApp: { slug: "notes", title: "Notes" } });
    profile = mkdtempSync(join(tmpdir(), "matrix-shim-profile-"));
    work = mkdtempSync(join(tmpdir(), "matrix-shim-e2e-"));
    const detected = await detectMacShimHost({ execPath: executablePath, appPath: join(root, "desktop"), isPackaged: false });
    if (!detected) throw new Error("Electron has no app shim loader");
    host = detected;
    await launch();
  }, 120_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app, 10_000);
    await run("/usr/bin/pkill", ["-f", work]).catch((error: unknown) => {
      // Exit 1 means no shim process was left running.
      if ((error as { code?: number }).code !== 1) throw error;
    });
    await gateway?.close();
    for (const dir of [profile, work]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("opens an installed app in its shim, under the app's own Dock name", async () => {
    record = await installer().install({ appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes" });
    expect(record.cdHashes.length).toBeGreaterThan(0);
    await run("/usr/bin/open", [record.bundlePath!]);
    const titles = await until(appWindowTitles, (found) => found.includes("Notes"));
    expect(titles.filter((title) => title === "Notes")).toHaveLength(1);
    const shim = await until(() => runningApp(`com.matrix-os.app.${record.installId}`), (found) => found !== null);
    expect(shim).toEqual({ name: "Notes", foreground: true });
  }, 60_000);

  it("rejects a hand-made bundle that points at the same server, with no window", async () => {
    const before = (await appWindowTitles()).length;
    const installId = randomUUID();
    const bundle = join(work, "Impostor.app");
    for (const file of shimBundleFiles({
      installId, displayName: "Impostor", hostPath: host.appPath, hostBundleId: host.bundleId,
      serverName: appShimServerName({ channel: "dev" }), hostArguments: [], loaderPath: host.loaderPath,
      icon: new Uint8Array(readFileSync(host.fallbackIcnsPath)),
    })) {
      const target = join(bundle, file.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "copyFrom" in file ? readFileSync(file.copyFrom) : file.contents, { mode: file.mode });
    }
    await run("/usr/bin/open", [bundle]);
    const rejected = await until(async () => logs.join(""), (text) => text.includes("rejected an app shim: unknown bundle"));
    expect(rejected).toContain("rejected an app shim: unknown bundle");
    await new Promise((settle) => setTimeout(settle, 1_000));
    expect((await appWindowTitles()).length).toBe(before);
    expect(await until(() => runningApp(`com.matrix-os.app.${installId}`), (found) => found === null, 10_000)).toBeNull();
  }, 60_000);

  it("quits the shim when its window closes, leaving Matrix running", async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => win.getTitle() === "Notes")?.close();
    });
    expect(await until(() => runningApp(`com.matrix-os.app.${record.installId}`), (found) => found === null, 15_000)).toBeNull();
    expect((await appWindowTitles()).length).toBeGreaterThan(0);
  }, 30_000);

  it("reopens an app that was open at quit, back in its shim", async () => {
    await run("/usr/bin/open", [record.bundlePath!]);
    await until(appWindowTitles, (found) => found.includes("Notes"));
    await closeElectronApp(app, 15_000);
    expect(await until(() => runningApp(`com.matrix-os.app.${record.installId}`), (found) => found === null, 15_000)).toBeNull();
    await launch();
    expect(await until(appWindowTitles, (found) => found.includes("Notes"), 45_000)).toContain("Notes");
    expect(await until(() => runningApp(`com.matrix-os.app.${record.installId}`), (found) => found !== null)).not.toBeNull();
  }, 120_000);

  it("uninstalls the bundle and its record, but not the app", async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => win.getTitle() === "Notes")?.close();
    });
    await until(() => runningApp(`com.matrix-os.app.${record.installId}`), (found) => found === null, 15_000);
    expect(await installer().uninstall(record.installId)).toBe(true);
    expect(existsSync(record.bundlePath!)).toBe(false);
    expect(await records().get(record.installId)).toBeNull();
  }, 30_000);
});
