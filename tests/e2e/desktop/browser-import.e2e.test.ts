import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const suite = existsSync(main) ? describe : describe.skip;

suite("Electron Desktop browser import", () => {
  let gateway: StubGateway | undefined;
  let app: ElectronApplication | undefined;
  let page: Page;
  let userDataDir: string | undefined;

  beforeAll(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "matrix-browser-import-e2e-"));
    const arc = join(userDataDir, "Library/Application Support/Arc");
    await mkdir(arc, { recursive: true });
    await writeFile(join(arc, "StorableSidebar.json"), JSON.stringify({ sidebar: {
      containers: [{ items: [
        "one", { id: "one", data: { tab: { savedURL: "https://example.com/imported", savedTitle: "Imported page" } } },
      ] }],
    } }));
    const arcProfile = join(arc, "User Data", "Default");
    await mkdir(arcProfile, { recursive: true });
    execFileSync("/usr/bin/sqlite3", [join(arcProfile, "Login Data"),
      "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER); INSERT INTO logins VALUES ('https://example.com/login', 'synthetic-user', X'76313000', 0);"]);
    execFileSync("/usr/bin/sqlite3", [join(arcProfile, "Cookies"),
      "CREATE TABLE cookies (host_key TEXT); INSERT INTO cookies VALUES ('.example.com');"]);
    const bin = join(userDataDir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "op"), `#!/bin/sh
if [ "$2" = "list" ]; then
  printf '%s' '[{"id":"abcdefghijkl","title":"Example login","category":"LOGIN","urls":[{"href":"https://example.com/login"}]}]'
else
  printf '%s' '{"id":"abcdefghijkl","title":"Example login","category":"LOGIN","urls":[{"href":"https://example.com/login"}],"fields":[{"id":"username","value":"synthetic-user"},{"id":"password","value":"synthetic-password","type":"CONCEALED"}]}'
fi
`, { mode: 0o755 });
    gateway = await startStubGateway();
    app = await _electron.launch({
      executablePath,
      args: [main],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    page = await app.firstWindow();
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).waitFor({ timeout: 20_000 });
    const gettingStarted = page.getByRole("dialog", { name: "Getting started" });
    if (await gettingStarted.isVisible()) {
      await page.getByRole("button", { name: /Getting started/ }).click();
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  it("imports a local Arc page and reopens it from Saved pages", async () => {
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    await page.getByRole("dialog", { name: "App launcher" })
      .getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByRole("button", { name: "Browser settings" }).click();
    await page.getByRole("button", { name: "Import from another browser" }).click();
    const evidence = join(root, "output/playwright/browser-import");
    await mkdir(evidence, { recursive: true });
    await page.getByRole("button", { name: "Import 1 page from Arc Sidebar" }).waitFor();
    await page.screenshot({ path: join(evidence, "electron-browser-import-picker.png") });
    await page.getByRole("button", { name: "Import 1 page from Arc Sidebar" }).click();
    await page.getByRole("button", { name: "Open Imported page" }).click();
    await expect.poll(async () => page.getByRole("textbox", { name: "Browser address" }).inputValue())
      .toBe("https://example.com/imported");
    await page.screenshot({ path: join(evidence, "electron-browser-import.png") });
  }, 60_000);

  it("previews Arc site metadata and imports a selected 1Password Login without exposing its password", async () => {
    await page.getByRole("button", { name: "Browser settings" }).click();
    await page.getByRole("button", { name: "Import from another browser" }).click();
    await page.getByRole("button", { name: "Arc · Default" }).click();
    await page.getByRole("checkbox", { name: /example.com.*password/ }).waitFor();
    await page.getByRole("button", { name: "Choose 1Password logins" }).click();
    await page.getByRole("checkbox", { name: /Example login/ }).check();
    await page.getByRole("button", { name: "Import selected logins (1)" }).click();
    await page.getByRole("status").filter({ hasText: "Imported 1 login from 1Password" }).waitFor();
    const accounts = await page.evaluate(async () => window.operator.invoke("browser:list-passwords", { origin: "https://example.com" }));
    expect(accounts).toEqual({ accounts: [{ username: "synthetic-user" }] });
    const evidence = join(root, "output/playwright/browser-import");
    await page.screenshot({ path: join(evidence, "electron-browser-secret-import.png") });
  }, 60_000);

  it("does not expose the first account's passwords after a second Matrix account signs in", async () => {
    const imported = await page.evaluate(async () => window.operator.invoke("browser:import-1password", { ids: ["abcdefghijkl"] }));
    expect(imported.imported).toBe(1);
    expect(await page.evaluate(async () => window.operator.invoke("browser:list-passwords", { origin: "https://example.com" })))
      .toEqual({ accounts: [{ username: "synthetic-user" }] });
    gateway!.setDeviceUserId("user-2");
    await page.evaluate(async () => window.operator.invoke("auth:sign-out", {}));
    await page.evaluate(async () => window.operator.invoke("auth:start-device-flow", {}));
    await expect.poll(async () => page.evaluate(async () => window.operator.invoke("auth:status", {})),
      { timeout: 20_000 }).toMatchObject({ signedIn: true, userId: "user-2" });
    const accounts = await page.evaluate(async () => window.operator.invoke("browser:list-passwords", { origin: "https://example.com" }));
    expect(accounts).toEqual({ accounts: [] });
  }, 60_000);

  it("closes Browser embeds on the first sign-out after restoring a saved account", async () => {
    const beforeRestart = await page.evaluate(async () => window.operator.invoke("auth:status", {}));
    expect(beforeRestart.signedIn).toBe(true);
    const expectedUserId = beforeRestart.signedIn ? beforeRestart.userId : null;
    await app!.close();
    app = await _electron.launch({
      executablePath,
      args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway!.url, OPERATOR_USER_DATA_DIR: userDataDir!,
        PATH: `${join(userDataDir!, "bin")}:${process.env.PATH ?? ""}` },
    });
    page = await app.firstWindow();
    expect(await page.evaluate(async () => window.operator.invoke("auth:status", {})))
      .toMatchObject({ signedIn: true, userId: expectedUserId });
    const opened = await page.evaluate(async () => window.operator.invoke("embed:open", {
      kind: "browser", url: "https://example.com", bounds: { x: 0, y: 0, width: 800, height: 600 },
    }));
    expect(opened.state).toBe("loading");
    await page.evaluate(async () => window.operator.invoke("auth:sign-out", {}));
    expect(await page.evaluate(async (embedId) => window.operator.invoke("embed:close", { embedId }), opened.embedId))
      .toEqual({ ok: false });
  }, 60_000);
});
