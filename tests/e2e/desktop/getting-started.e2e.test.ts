import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const evidence = join(root, "output/playwright/getting-started");
const hasBuild = existsSync(main);
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasBuild) {
  throw new Error("Run bun run build:desktop before the required Getting started regression suite");
}
const suite = hasBuild ? describe : describe.skip;

suite("Electron Getting started overlay coexistence", () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let gateway: StubGateway | undefined;
  let userDataDir: string | undefined;
  beforeAll(async () => {
    if (!existsSync(main)) throw new Error("Run bun run build:desktop before this regression suite");
    mkdirSync(evidence, { recursive: true });
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-checklist-e2e-"));
    gateway = await startStubGateway();
    app = await _electron.launch({ executablePath, args: [main], env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userDataDir } });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /continue in browser/i }).waitFor();
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: /Getting started/ }).waitFor({ timeout: 20_000 });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("restores the checklist across both presentations without taking launcher or palette focus", async () => {
    const card = page.getByRole("dialog", { name: "Getting started" });
    const trigger = page.getByRole("button", { name: /Getting started/ });
    if (!await card.isVisible()) await trigger.click();
    for (const presentation of ["desktop", "canvas"] as const) {
      await card.waitFor();
      await page.screenshot({ path: join(evidence, `${presentation}-checklist.png`) });
      await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
      await card.waitFor({ state: "detached" });
      const launcher = page.getByRole("dialog", { name: "App launcher", exact: true });
      await launcher.waitFor();
      const search = launcher.getByRole("textbox");
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      await search.fill("Terminal");
      await page.screenshot({ path: join(evidence, `${presentation}-launcher.png`) });
      await page.keyboard.press("Escape");
      await card.waitFor();
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(false);
      await page.keyboard.press("Meta+k");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      await palette.waitFor();
      await card.waitFor({ state: "detached" });
      await page.screenshot({ path: join(evidence, `${presentation}-palette.png`) });
      await page.keyboard.press("Escape");
      await card.waitFor();
      if (presentation === "desktop") {
        await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
        await launcher.getByRole("textbox").fill("");
        await launcher.getByRole("button", { name: /Web Canvas|Canvas/ }).click();
        await card.waitFor();
      }
    }
    await trigger.click();
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    await page.keyboard.press("Escape");
    expect(await card.count()).toBe(0);
  }, 60_000);
});
