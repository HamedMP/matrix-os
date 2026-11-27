// Installs an app from the Electron Desktop launcher and uninstalls it again
// (spec 2711, layer 4). Linux: checks the `.desktop` entry and opens the app
// through it (a second Matrix process hands the link to the running one).
// macOS: checks the shim bundle and its own Dock identity (`lsappinfo`). HOME is
// a temp folder, so nothing lands in the owner's real Applications or menus.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const linux = process.platform === "linux";
const mac = process.platform === "darwin";
const suite = hasDesktopBuild && (linux || mac) ? describe : describe.skip;
const run = promisify(execFile);

/** macOS: the app registered with the Dock under `bundleId`, if running (no Automation permission needed). */
async function runningApp(bundleId: string): Promise<string | null> {
  const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", "-app", bundleId]);
  return /"LSDisplayName"="([^"]*)"/.exec(stdout)?.[1] ?? null;
}
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;

/** Splits a Desktop Entry `Exec` value: string escapes first, then quoting (spec 1.5). */
function parseExec(value: string): string[] {
  const unescaped = value.replace(/\\\\/g, "\\");
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < unescaped.length; index += 1) {
    const char = unescaped[index]!;
    if (quoted && char === "\\") { current += unescaped[++index] ?? ""; continue; }
    if (char === "\"") { quoted = !quoted; started = true; continue; }
    if (!quoted && char === " ") {
      if (started) args.push(current.replace(/%%/g, "%"));
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) args.push(current.replace(/%%/g, "%"));
  return args;
}

suite("Electron Desktop installs an app on Linux", () => {
  let app: ElectronApplication;
  let main: Page;
  let gateway: StubGateway;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let installId = "";

  const applications = () => join(home, ".local", "share", "applications");
  const entryPath = () => join(applications(), `matrix-app-${installId}.desktop`);
  const records = () => {
    const path = join(home, "profile", "installed-apps.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { records: Array<{ installId: string; slug: string; bundlePath: string }> }).records : [];
  };
  const appWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((win) => win.getTitle() === "Team Tracker")
    .map((win) => win.contentView.children.flatMap((view) => "webContents" in view ? [(view as Electron.WebContentsView).webContents.getURL()] : [])));
  const until = async <T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value) || Date.now() > deadline) return value;
      await new Promise((settle) => setTimeout(settle, 200));
    }
  };

  const openLauncherMenu = async (name: string) => {
    await main.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    const launcher = main.getByRole("dialog", { name: "App launcher", exact: true });
    await launcher.getByRole("textbox").fill("Team Tracker");
    await launcher.getByRole("button", { name: "Team Tracker", exact: true }).click({ button: "right" });
    await main.getByRole("menuitem", { name }).click();
  };

  beforeAll(async () => {
    gateway = await startStubGateway({ installedApp: { slug: "team-tracker", title: "Team Tracker" } });
    home = mkdtempSync(join(tmpdir(), "matrix-install-app-"));
    env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      OPERATOR_GATEWAY_URL: gateway.url,
      OPERATOR_USER_DATA_DIR: join(home, "profile"),
    };
    // Launch the app directory, like `electron .`: its app path then holds `build/`, which an
    // unpackaged macOS install uses for the fallback shim icon (the stub gateway serves none).
    app = await _electron.launch({ executablePath, args: [join(root, "desktop"), "--use-mock-keychain"], env });
    // Pick the main window by its page: an app window can open first.
    main = await (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const found = app.windows().find((page) => page.url().includes("/renderer/index.html"));
        if (found) return found;
        if (Date.now() > deadline) throw new Error("the main window never opened");
        await new Promise((settle) => setTimeout(settle, 100));
      }
    })();
    await main.getByRole("button", { name: /create account/i }).waitFor({ timeout: 30_000 });
    await main.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await main.getByRole("button", { name: "Open account menu", exact: true }).waitFor({ timeout: 15_000 });
  }, 120_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    if (mac && home) {
      await run("/usr/bin/pkill", ["-f", home]).catch((error: unknown) => {
        // Exit 1 means no shim process was left running.
        if ((error as { code?: number }).code !== 1) throw error;
      });
    }
    await gateway?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("installs Team Tracker from the launcher's context menu", async () => {
    await openLauncherMenu("Install as App…");
    const sheet = main.getByRole("dialog", { name: "Install Team Tracker?" });
    await sheet.getByText("Uses the same access it has inside Matrix.").waitFor();
    await sheet.getByRole("button", { name: "Install", exact: true }).click();
    await main.getByText("Installed Team Tracker").waitFor({ timeout: 15_000 });
    const [record] = records();
    installId = record!.installId;
    if (linux) {
      expect(record).toEqual(expect.objectContaining({ slug: "team-tracker", bundlePath: entryPath() }));
      const entry = readFileSync(entryPath(), "utf8");
      expect(entry).toContain("Name=Team Tracker\n");
      expect(entry).toContain(`StartupWMClass=matrix-app-${installId}\n`);
      expect(entry).toMatch(new RegExp(`^Exec=.* matrixos://app/${installId}$`, "m"));
    } else {
      expect(record!.bundlePath).toBe(join(realpathSync(home), "Applications", "Matrix Apps", "Team Tracker.app"));
      expect(existsSync(join(record!.bundlePath!, "Contents", "Info.plist"))).toBe(true);
      expect(await main.getByRole("button", { name: "Show in Finder" }).count()).toBe(1);
      // The shim connected and runs under the app's own name, apart from Matrix.
      expect(await until(() => runningApp(`com.matrix-os.app.${installId}`), (name) => name !== null, 30_000)).toBe("Team Tracker");
    }
    // Installing opens the app in its own window.
    const windows = await until(appWindows, (found) => found.some((urls) => urls.some((url) => url.includes("/apps/team-tracker/"))));
    expect(windows).toHaveLength(1);
  }, 60_000);

  it.skipIf(!linux)("opens the installed app through its desktop entry", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle() === "Team Tracker")?.close());
    await until(appWindows, (found) => found.length === 0);
    const exec = parseExec(/^Exec=(.*)$/m.exec(readFileSync(entryPath(), "utf8"))![1]!);
    expect(exec.at(-1)).toBe(`matrixos://app/${installId}`);
    // A second Matrix process, as the desktop would start it, passes the link to this one and exits.
    // Like Playwright's own Linux launch (and preview-pair.e2e), the fixture process runs
    // without Chromium's sandbox: hosted runners may deny its user namespace.
    const exited = await new Promise<number | null>((settle, fail) => {
      const child = spawn(exec[0]!, ["--no-sandbox", ...exec.slice(1)], { env, stdio: "ignore" });
      child.once("error", fail);
      child.once("exit", (code) => settle(code));
    });
    expect(exited).toBe(0);
    const windows = await until(appWindows, (found) => found.some((urls) => urls.some((url) => url.includes("/apps/team-tracker/"))));
    expect(windows).toHaveLength(1);
  }, 60_000);

  it("uninstalls it, removing the entry and the record but not the app", async () => {
    await main.bringToFront();
    await openLauncherMenu("Uninstall App…");
    const confirm = main.getByRole("alertdialog", { name: "Uninstall Team Tracker?" });
    await confirm.getByRole("button", { name: "Uninstall", exact: true }).click();
    await main.getByText("Uninstalled Team Tracker").waitFor({ timeout: 15_000 });
    expect(existsSync(linux ? entryPath() : join(realpathSync(home), "Applications", "Matrix Apps", "Team Tracker.app"))).toBe(false);
    expect(records()).toEqual([]);
    if (mac) expect(await until(() => runningApp(`com.matrix-os.app.${installId}`), (name) => name === null)).toBeNull();
    expect(await until(appWindows, (found) => found.length === 0)).toEqual([]);
    // The app itself is still in the catalog.
    await main.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    await main.getByRole("dialog", { name: "App launcher", exact: true }).getByRole("button", { name: "Team Tracker", exact: true }).waitFor();
  }, 60_000);
});
