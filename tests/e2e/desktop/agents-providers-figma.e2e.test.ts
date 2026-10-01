import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startAgentsProvidersWorkflowGateway } from "./fixtures/agents-providers-workflows";

const root = resolve(__dirname, "../../..");
const evidence = join(root, "specs/543-agents-providers-settings/evidence/electron-fixture");
const hasBuild = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasBuild) throw new Error("Required Electron Desktop build is missing");
const suite = hasBuild ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
let gateway: Awaited<ReturnType<typeof startAgentsProvidersWorkflowGateway>>;
let app: ElectronApplication;
let page: Page;
let profile: string;

suite("Electron Desktop Agents & providers Figma workflows (synthetic gateway)", () => {
  beforeAll(async () => {
    mkdirSync(evidence, { recursive: true });
    gateway = await startAgentsProvidersWorkflowGateway();
    profile = mkdtempSync(join(tmpdir(), "matrix-settings-figma-"));
    app = await _electron.launch({ executablePath, args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
    const checklist = page.getByRole("button", { name: /^Getting started —/ });
    if (await checklist.getAttribute("aria-expanded") === "true") await checklist.click();
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
    try { await page.getByRole("region", { name: "General agents", exact: true }).waitFor({ timeout: 10_000 }); }
    catch (error) { await page.screenshot({ path: join(evidence, "setup-failure.png") }); console.warn("[figma-e2e] setup state:", await page.locator("body").innerText()); throw error; }
  }, 60_000);
  afterAll(async () => { await app?.close(); await gateway?.close(); if (profile) rmSync(profile, { recursive: true, force: true }); });

  async function capture(name: string) { await page.screenshot({ path: join(evidence, `${name}.png`) }); }
  const feature = () => page.locator(".matrix-agents-providers");
  async function select(name: string) {
    const row = feature().locator(".matrix-ap-rail-item").filter({ hasText: name }).first();
    if (await row.getAttribute("aria-expanded") !== "true") await row.click();
    await expect.poll(() => row.getAttribute("aria-expanded"), { timeout: 5_000 }).toBe("true");
  }
  it("executes grouped inventory, history, device-code recovery, key validation, install cancellation, and disconnect", async () => {
    try {
      expect(await app.evaluate(({ app }) => app.getAppPath())).toBe(join(root, "desktop/out/main"));
      expect(await feature().getByRole("region", { name: "Coding agents" }).locator(".matrix-ap-rail-item").count()).toBe(4);
      expect(await feature().getByRole("region", { name: "General agents" }).locator(".matrix-ap-rail-item").count()).toBe(2);
      await feature().getByText(/\$18\.40/).waitFor();
      await capture("01-overview-small");
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Missing Electron Desktop window");
        window.setSize(1500, 1100);
      });
      await capture("01-overview");
      await feature().getByRole("region", { name: "Installed agents", exact: true }).scrollIntoViewIfNeeded();
      await capture("01-grouped-overview");
      await feature().getByRole("heading", { name: "Agents & providers", exact: true }).scrollIntoViewIfNeeded();

      await feature().getByRole("button", { name: "Usage history", exact: true }).click();
      const history = page.getByRole("dialog", { name: "Usage history", exact: true });
      await history.getByRole("button", { name: "Load more", exact: true }).waitFor();
      expect(await history.locator("tbody tr").count()).toBe(1);
      await history.getByRole("button", { name: "Load more", exact: true }).click();
      await history.locator("tbody tr").filter({ hasText: "Credit" }).waitFor();
      expect(await history.locator("tbody tr").count()).toBe(2);
      expect(gateway.events.filter(event => event === "history")).toHaveLength(2);
      await capture("02-history");
      await history.getByRole("button", { name: "Close", exact: true }).click();

      await select("Codex");
      const codex = feature().getByRole("region", { name: "Codex connection", exact: true });
      await codex.getByRole("button", { name: /ChatGPT account/ }).waitFor();
      await codex.getByRole("button", { name: /ChatGPT account/ }).scrollIntoViewIfNeeded();
      await capture("03-connect-chooser");
      await codex.getByRole("button", { name: /ChatGPT account/ }).click();
      await codex.getByText("TEST-CODE", { exact: true }).waitFor();
      await codex.getByRole("button", { name: "Copy", exact: true }).click();
      await codex.getByRole("button", { name: "Copied", exact: true }).waitFor();
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("TEST-CODE");
      await capture("04-device-code");
      await page.getByRole("dialog", { name: "Settings window", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
      await feature().waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Open account menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
      await select("Codex");
      await codex.getByText("TEST-CODE", { exact: true }).waitFor();
      await codex.getByText("TEST-CODE", { exact: true }).scrollIntoViewIfNeeded();
      expect(gateway.events.filter(event => event === "login")).toHaveLength(1);
      await capture("04-device-code-reopened");
      gateway.expireLogin();
      await codex.getByText("The sign-in code expired.", { exact: true }).waitFor({ timeout: 10_000 });
      await capture("05-device-expired");
      await codex.getByRole("button", { name: "Try again", exact: true }).click();
      await codex.getByText("TEST-CODE", { exact: true }).waitFor();
      expect(gateway.events.filter(event => event === "login")).toHaveLength(2);
      await codex.getByRole("button", { name: "Cancel", exact: true }).click();
      await codex.getByRole("button", { name: /^API key/ }).click();
      const key = codex.getByLabel("Paste your OpenAI API key", { exact: true });
      expect(await key.getAttribute("type")).toBe("password");
      await key.fill("invalid-key-for-fixture");
      await codex.getByRole("button", { name: "Connect", exact: true }).click();
      await codex.getByRole("alert").getByText("The key could not be verified. Check it and try again.", { exact: true }).waitFor();
      expect(await key.getAttribute("aria-invalid")).toBe("true");
      await capture("06-key-rejected");
      await key.fill("sk-safe-fixture-valid");
      await codex.getByRole("button", { name: "Try again", exact: true }).click();
      await codex.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
      expect(gateway.events.filter(event => event === "key-check")).toHaveLength(2);
      await capture("07-key-connected");

      await codex.getByRole("button", { name: "View logs", exact: true }).click();
      await codex.getByRole("region", { name: "Connection logs", exact: true }).waitFor();
      await codex.getByRole("button", { name: "Close logs", exact: true }).click();
      await codex.getByRole("button", { name: "Disconnect", exact: true }).click();
      const disconnect = page.getByRole("dialog", { name: "Disconnect Codex?", exact: true });
      await disconnect.waitFor();
      const uninstall = disconnect.getByRole("checkbox");
      expect(await uninstall.isChecked()).toBe(false);
      await capture("08-disconnect-confirm");
      await disconnect.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(gateway.events).not.toContain("disconnect");
      await codex.getByRole("button", { name: "Disconnect", exact: true }).click();
      await disconnect.getByRole("button", { name: "Disconnect", exact: true }).click();
      await codex.getByRole("button", { name: /ChatGPT account/ }).waitFor();
      expect(gateway.events).toContain("disconnect");

      await select("Hermes");
      const hermes = feature().getByRole("region", { name: "Hermes connection", exact: true });
      await hermes.getByRole("button", { name: "Install", exact: true }).click();
      const progress = hermes.getByRole("progressbar", { name: "Installing Hermes", exact: true });
      await progress.waitFor();
      expect(await progress.getAttribute("value")).toBeNull();
      const terminal = page.getByRole("dialog", { name: "Terminal window", exact: true });
      await terminal.waitFor();
      await capture("09-install-terminal-visible");
      await terminal.getByRole("button", { name: "Close", exact: true }).click();
      await terminal.waitFor({ state: "hidden" });
      await capture("09-install-indeterminate");
      await hermes.getByRole("button", { name: "Cancel", exact: true }).click();
      await hermes.getByRole("button", { name: "Install", exact: true }).waitFor();
      expect(gateway.events.filter(event => event === "cancel")).toHaveLength(2);
    } catch (error) { await capture("failure"); throw error; }
  }, 90_000);
});
