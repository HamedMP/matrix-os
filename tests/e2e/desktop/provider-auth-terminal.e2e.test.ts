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

suite("Desktop provider authentication Terminal", () => {
beforeAll(async () => {
  mkdirSync(output, { recursive: true });
  gateway = await startProviderAuthGateway();
  profile = mkdtempSync(join(tmpdir(), "matrix-om255-"));
  app = await _electron.launch({ executablePath,
    args: [join(root, "desktop/out/main/index.js"), "--remote-debugging-port=9353"],
    env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
  });
  // Prevent the stub auth flow from opening any external browser.
  await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
  page = await app.firstWindow();
  await page.getByRole("button", { name: /continue in browser/i }).waitFor();
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
}

it("reveals a closed Terminal for Connect and refreshes auth after logout", async () => {
  try {
    const identity = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath());
    expect(identity).toBe(join(root, "desktop/out/main"));
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
    const terminal = page.getByRole("dialog", { name: "Terminal window", exact: true });
    await terminal.waitFor();
    await terminal.getByRole("button", { name: "Close", exact: true }).click();
    await terminal.waitFor({ state: "hidden" });
    await settings();
    await page.getByRole("button", { name: "Log in Claude", exact: true }).click();
    await page.getByRole("button", { name: "Continue in Terminal", exact: true }).click();
    await terminal.waitFor();
    await terminal.getByText("Connect Claude", { exact: true }).first().waitFor();
    expect(gateway.commands).toHaveLength(1);
    expect(gateway.commands[0]).toMatchObject({ name: "Connect Claude", command: ["sh", "-lc", "claude auth login"] });
    await page.screenshot({ path: join(output, "connect-visible.png") });

    gateway.setAuthenticated(true);
    await terminal.getByRole("button", { name: "Close", exact: true }).click();
    await settings();
    const disconnect = page.getByRole("button", { name: "Log out Claude", exact: true });
    await disconnect.waitFor();
    expect(await page.getByRole("button", { name: "Log in Claude", exact: true }).count()).toBe(0);
    await page.screenshot({ path: join(output, "authenticated-disconnect.png") });
    await disconnect.click();
    await terminal.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Log in Claude", exact: true }).waitFor();
    expect(gateway.commands).toHaveLength(1);
    await page.screenshot({ path: join(output, "logged-out.png") });
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") });
    throw error;
  }
}, 60_000);

});
