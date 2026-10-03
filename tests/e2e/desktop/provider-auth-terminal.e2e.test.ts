import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startProviderAuthGateway } from "./fixtures/provider-auth-gateway";

const root = resolve(__dirname, "../../..");
const output = join(root, "output/playwright/om-255");
const hasDesktopBuild = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasDesktopBuild) {
  throw new Error("Required Desktop E2E build is missing");
}
const suite = hasDesktopBuild ? describe : describe.skip;
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>>;
let app: ElectronApplication;
let page: Page;
let profile: string;

suite("Electron Desktop provider authentication Settings", () => {
beforeAll(async () => {
  mkdirSync(output, { recursive: true });
  gateway = await startProviderAuthGateway({ inlineClaude: true });
  profile = mkdtempSync(join(tmpdir(), "matrix-om255-"));
  app = await _electron.launch({ executablePath,
    args: [join(root, "desktop/out/main/index.js"), "--remote-debugging-port=9353"],
    env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
  });
  // Prevent the stub auth flow from opening any external browser.
  await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
  page = await app.firstWindow();
  await page.getByRole("button", { name: /create account/i }).waitFor();
  await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
  await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await gateway?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

async function settings() {
  await page.getByRole("button", { name: "Open account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Agents & providers", exact: true }).click();
  const claude = page.locator(".matrix-ap-rail-item").filter({ hasText: "Claude" }).first();
  if (await claude.getAttribute("aria-expanded") !== "true") await claude.click();
}

it("keeps browser login, cancellation, completion and selected-agent disconnect in Settings without opening Terminal", async () => {
  try {
    const identity = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath());
    expect(identity).toBe(join(root, "desktop/out/main"));
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
    const terminal = page.getByRole("dialog", { name: "Terminal window", exact: true });
    await terminal.waitFor();
    await terminal.getByRole("button", { name: "Close", exact: true }).click();
    await terminal.waitFor({ state: "hidden" });
    await settings();
    const accountChoice = page.getByRole("button", { name: /Claude account.*Use your Claude plan/ });
    await accountChoice.click();
    await page.getByRole("heading", { name: "Finish signing in to Claude", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open sign-in page", exact: true }).waitFor();
    await page.getByLabel("Paste the sign-in code", { exact: true }).waitFor();
    expect(gateway.workflowEvents).toEqual(["browser-login"]);
    await terminal.waitFor({ state: "hidden" });
    expect(gateway.commands).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await accountChoice.waitFor();
    expect(gateway.workflowEvents).toEqual(["browser-login", "cancel"]);
    await accountChoice.click();
    await page.getByLabel("Paste the sign-in code", { exact: true }).fill("synthetic-fixture-code");
    await page.getByRole("button", { name: "Finish connecting", exact: true }).click();
    const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
    await disconnect.waitFor();
    const claudeRow = page.locator(".matrix-ap-rail-item").filter({ hasText: "Claude" }).first();
    expect(await claudeRow.getAttribute("aria-expanded")).toBe("true");
    expect(await claudeRow.textContent()).toContain("Connected");
    expect(gateway.workflowEvents).toEqual(["browser-login", "cancel", "browser-login", "code-completed"]);
    await terminal.waitFor({ state: "hidden" });
    expect(gateway.commands).toHaveLength(0);
    await page.screenshot({ path: join(output, "settings-browser-connected.png") });
    await disconnect.click();
    await page.getByRole("dialog", { name: "Disconnect Claude?", exact: true }).getByRole("button", { name: "Disconnect", exact: true }).click();
    await accountChoice.waitFor();
    expect(await claudeRow.textContent()).toContain("Not connected");
    expect(gateway.workflowEvents.at(-1)).toBe("agent-disabled");
    // Fixture HTTP state independently proves Disconnect did not log out the account.
    const retained = await (await fetch(`${gateway.url}/api/ai/provider-settings`, {signal: AbortSignal.timeout(5000)})).json();
    expect(retained.accounts[0].authState).toBe("authenticated");
    expect(retained.harnesses[0].enabled).toBe(false);
    await terminal.waitFor({ state: "hidden" });
    expect(gateway.commands).toHaveLength(0);
    await page.screenshot({ path: join(output, "settings-browser-disconnected.png") });
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") });
    throw error;
  }
}, 60_000);

});
