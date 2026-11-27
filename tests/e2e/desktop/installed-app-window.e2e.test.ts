import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const suite = hasDesktopBuild ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;

const NOTES_ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const GONE_ID = "0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const record = (installId: string, slug: string, name: string) => ({
  installId, appIdentity: slug, slug, runtimeSlot: "primary", name,
  iconSha256: "a".repeat(64), bundlePath: null, cdHashes: [], createdAt: "2026-11-27T10:00:00.000Z",
});

interface WindowSnapshot { title: string; pageUrl: string; viewUrls: string[]; viewWakeLocksDisabled: boolean[] }

suite("Electron Desktop installed app windows", () => {
  let app: ElectronApplication;
  let main: Page;
  let gateway: StubGateway;
  let profile: string;
  let quit = false;

  const snapshot = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
    title: win.getTitle(),
    pageUrl: win.webContents.getURL(),
    viewUrls: win.contentView.children.flatMap((view) => "webContents" in view ? [(view as Electron.WebContentsView).webContents.getURL()] : []),
    viewWakeLocksDisabled: win.contentView.children.flatMap((view) => "webContents" in view
      ? [Boolean((view as Electron.WebContentsView).webContents.getLastWebPreferences()?.disableWakeLocks)] : []),
  }))) as Promise<WindowSnapshot[]>;

  const appWindows = async (title: string) => (await snapshot()).filter((win) => win.title === title);

  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value) || Date.now() > deadline) return value;
      await new Promise((settle) => setTimeout(settle, 200));
    }
  };

  const openLink = (url: string) => app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit("open-url", { preventDefault() {} }, link);
  }, url);

  beforeAll(async () => {
    gateway = await startStubGateway({ installedApp: { slug: "notes", title: "Notes" } });
    profile = mkdtempSync(join(tmpdir(), "matrix-installed-app-"));
    writeFileSync(join(profile, "installed-apps.json"), JSON.stringify({
      version: 1, records: [record(NOTES_ID, "notes", "Notes"), record(GONE_ID, "gone", "Gone")],
    }));
    // Cold start with the link in argv, as Windows and Linux deliver it, before signing in.
    app = await _electron.launch({
      executablePath,
      // The mock keychain keeps macOS from prompting for safeStorage access.
      args: [join(root, "desktop/out/main/index.js"), "--use-mock-keychain", `matrixos://app/${NOTES_ID}`],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    main = await app.firstWindow();
  }, 90_000);

  afterAll(async () => {
    if (app && !quit) await closeElectronApp(app);
    await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("asks the owner to sign in to Matrix before opening the app", async () => {
    const windows = await until(() => appWindows("Notes"),
      (found) => found.some((win) => decodeURIComponent(win.pageUrl).includes("Sign in to Matrix to open Notes")));
    expect(windows).toHaveLength(1);
    expect(decodeURIComponent(windows[0]!.pageUrl)).toContain("https://installed-app.matrix-os.invalid/open-matrix");
    expect(windows[0]!.viewUrls).toEqual([]);
  });

  it("opens the installed app in its own window through the owner launch path once signed in", async () => {
    await main.getByRole("button", { name: /create account/i }).waitFor({ timeout: 30_000 });
    await main.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await main.getByRole("button", { name: "Open account menu", exact: true }).waitFor({ timeout: 15_000 });
    const windows = await until(() => appWindows("Notes"),
      (found) => found.some((win) => win.viewUrls.some((url) => url.includes("/apps/notes/?launch=stub-launch"))));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.viewUrls).toEqual([`${gateway.url}/apps/notes/?launch=stub-launch`]);
    expect(windows[0]!.viewWakeLocksDisabled).toEqual([true]);
    const heading = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Notes")!;
      const view = win.contentView.children.find((child) => "webContents" in child) as Electron.WebContentsView;
      return view.webContents.executeJavaScript("document.querySelector('h1')?.textContent");
    });
    expect(heading).toBe("Notes app");
  });

  it("denies popups from the app and keeps its window title", async () => {
    const opened = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Notes")!;
      const view = win.contentView.children.find((child) => "webContents" in child) as Electron.WebContentsView;
      return view.webContents.executeJavaScript("window.open('https://example.test/') === null");
    });
    expect(opened).toBe(true);
    expect(await appWindows("Notes")).toHaveLength(1);
  });

  it("focuses the open window instead of creating a second one for a repeated link", async () => {
    await openLink(`matrixos://app/${NOTES_ID}`);
    await new Promise((settle) => setTimeout(settle, 1_000));
    expect(await appWindows("Notes")).toHaveLength(1);
  });

  it("ignores links that are not a recorded install", async () => {
    const before = (await snapshot()).length;
    await openLink("matrixos://app/notes");
    await openLink("matrixos://app/11111111-2222-4333-8444-555555555555");
    await new Promise((settle) => setTimeout(settle, 1_000));
    expect((await snapshot()).length).toBe(before);
  });

  it("shows a safe empty state with Retry, not an error, when the app is gone", async () => {
    await openLink(`matrixos://app/${GONE_ID}`);
    const windows = await until(() => appWindows("Gone"),
      (found) => found.some((win) => decodeURIComponent(win.pageUrl).includes("isn&#39;t available")));
    expect(windows).toHaveLength(1);
    const page = decodeURIComponent(windows[0]!.pageUrl);
    expect(page).toContain("Gone isn&#39;t available");
    expect(page).toContain("https://installed-app.matrix-os.invalid/retry");
    expect(windows[0]!.viewUrls).toEqual([]);
  });

  it("closes app windows on sign-out", async () => {
    await main.evaluate(() => window.operator.invoke("auth:sign-out", {}));
    const windows = await until(() => appWindows("Notes"), (found) => found.length === 0);
    expect(windows).toHaveLength(0);
    // Reopen it for the quit check; signed out, it shows the sign-in state.
    await openLink(`matrixos://app/${NOTES_ID}`);
    expect(await until(() => appWindows("Notes"), (found) => found.length === 1)).toHaveLength(1);
  });

  it("closes app windows on quit and keeps each install's window state", async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Notes")!
        .setBounds({ x: 40, y: 60, width: 960, height: 640 });
    });
    quit = true;
    await closeElectronApp(app, 10_000);
    const state = JSON.parse(readFileSync(join(profile, "state.json"), "utf8")) as {
      installedAppWindowBounds?: Record<string, { width: number; height: number }>;
    };
    expect(state.installedAppWindowBounds?.[NOTES_ID]).toEqual(expect.objectContaining({ width: 960, height: 640 }));
  }, 30_000);
});
