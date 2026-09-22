import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startSubagentGateway } from "./fixtures/subagent-gateway";
import { closeElectronApp } from "./fixtures/close-electron";

const root = resolve(__dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Desktop build missing");
const suite = built ? describe : describe.skip;
let app: ElectronApplication, page: Page, profile: string;
let gateway: Awaited<ReturnType<typeof startSubagentGateway>>;

suite("subagent activity in built Electron Desktop", () => {
  beforeAll(async () => {
    gateway = await startSubagentGateway();
    profile = await mkdtemp(join(tmpdir(), "chat-subagent-review-"));
    const launch = () => _electron.launch({ executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app, safeStorage }) => {
      await app.whenReady();
      return safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "user-1", handle: "neo" })).toString("base64");
    });
    await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app); app = await launch(); page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
  }, 60_000);
  afterAll(async () => {
    if (page && !page.isClosed()) { await mkdir(join(root, "output/chat-subagent-activity"), { recursive: true }); await page.screenshot({ path: join(root, "output/chat-subagent-activity/last-state.png") }); }
    if (app) await closeElectronApp(app);
    await gateway?.close(); if (profile) await rm(profile, { recursive: true, force: true });
  });
  it("shows completed, failed and unresolved children without duplicating rows after reload", async () => {
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
      await page.getByRole("button", { name: "Subagent activity review", exact: true }).click();
      const worked = page.getByRole("button", { name: /Worked for/ });
      await worked.waitFor();
      if (await worked.getAttribute("aria-expanded") !== "true") await worked.click();
      const arithmetic = page.getByRole("button", { name: "Arithmetic · Completed", exact: true });
      await arithmetic.waitFor();
      expect(await arithmetic.count()).toBe(1);
      expect(await arithmetic.locator("svg").getAttribute("data-subagent-icon")).toBe("agent");
      for (const [name, icon] of [["Tests · Failed", "code"], ["Review · Status unavailable", "review"], ["Explore · Completed", "search"]]) {
        expect(await page.getByRole("button", { name, exact: true }).locator("svg").getAttribute("data-subagent-icon")).toBe(icon);
      }
      await arithmetic.click();
      await page.getByText("437", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Tests · Failed", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Review · Status unavailable", exact: true }).count()).toBe(1);
      expect(await page.getByText("Parent response remains separate.", { exact: true }).count()).toBe(1);
    }
    if (await page.getByRole("dialog", { name: "Getting started", exact: true }).isVisible()) await page.getByRole("button", { name: /Getting started/ }).click();
    const output = join(root, "output/chat-subagent-activity"); await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, "electron-subagent-activity.png") });
  });
});
