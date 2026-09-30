import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startProviderAuthGateway } from "./fixtures/provider-auth-gateway";

const root = resolve(__dirname, "../../..");
const output = join(root, "output/playwright/eng-60");
const hasBuild = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasBuild) {
  throw new Error("Required Electron Desktop build is missing");
}
const suite = hasBuild ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>>;
let app: ElectronApplication;
let page: Page;
let profile: string;

suite("Electron Desktop Chat onboarding", () => {
  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    gateway = await startProviderAuthGateway();
    profile = mkdtempSync(join(tmpdir(), "matrix-eng60-"));
    app = await _electron.launch({
      executablePath, args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    // Keep the isolated fixture's device login local to this test.
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("dialog", { name: "Chat window", exact: true }).waitFor({ timeout: 20_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("opens one Chat, connects through its server Terminal, preserves the draft, and honors close", async () => {
    const chat = page.getByRole("dialog", { name: "Chat window", exact: true });
    try {
      expect(await chat.count()).toBe(1);
      await chat.getByRole("button", { name: "Connect Claude Code", exact: true }).waitFor();
      expect(await chat.getByRole("button", { name: "Connect Codex", exact: true }).isEnabled()).toBe(false);
      const draft = chat.getByRole("textbox", { name: "Start a chat", exact: true });
      await draft.fill("Keep this onboarding draft");
      await page.screenshot({ path: join(output, "electron-disconnected.png") });

      await chat.getByRole("button", { name: "Connect Claude Code", exact: true }).click();
      const terminal = page.getByRole("dialog", { name: "Terminal window", exact: true });
      await terminal.waitFor();
      await terminal.getByText("Connect Claude", { exact: true }).first().waitFor();
      expect(gateway.commands).toHaveLength(1);
      expect(gateway.commands[0]).toMatchObject({
        name: "Connect Claude", command: ["sh", "-lc", "claude auth login"],
      });
      expect(await chat.count()).toBe(1);
      await page.screenshot({ path: join(output, "electron-connect-terminal.png") });

      gateway.setAuthenticated(true);
      await terminal.getByRole("button", { name: "Close", exact: true }).click();
      await chat.getByRole("button", { name: "Check connection", exact: true }).click();
      await chat.getByRole("button", { name: "Connect Claude Code", exact: true }).waitFor({ state: "hidden" });
      expect(await draft.innerText()).toBe("Keep this onboarding draft");
      expect(await chat.count()).toBe(1);
      await page.screenshot({ path: join(output, "electron-connected-draft.png") });

      await chat.getByRole("button", { name: "Close", exact: true }).click();
      await chat.waitFor({ state: "hidden" });
      // A provider/auth refresh must not turn closing Chat into an automatic reopen.
      await page.getByRole("button", { name: "Open account menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
      await page.getByRole("button", { name: "Log out Claude", exact: true }).waitFor();
      expect(await chat.count()).toBe(0);
      await page.screenshot({ path: join(output, "electron-closed-chat.png") });
    } catch (error) {
      await page.screenshot({ path: join(output, "failure.png") });
      throw error;
    }
  }, 60_000);
});
