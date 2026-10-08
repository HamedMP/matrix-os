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
const evidence = join(root, "output/playwright/company-brain");
const hasBuild = existsSync(main);
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasBuild) {
  throw new Error("Run bun run build:desktop before the required Company Brain suite");
}
const suite = hasBuild ? describe : describe.skip;

suite("Electron Desktop Company Brain", () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let gateway: StubGateway | undefined;
  let userDataDir: string | undefined;
  beforeAll(async () => {
    mkdirSync(evidence, { recursive: true });
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-company-brain-e2e-"));
    gateway = await startStubGateway({ projectId: "proj_matrix_os" });
    app = await _electron.launch({
      executablePath, args: [main],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userDataDir },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).waitFor({ timeout: 20_000 });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  const brainWindow = () => page.getByRole("dialog", { name: "Company Brain window", exact: true });

  it("opens from the launcher on the Chat tab, with the title bar, the project picker and the six tabs", async () => {
    await page.getByRole("button", { name: "Open App Launcher", exact: true }).click();
    const launcher = page.getByRole("dialog", { name: "App launcher", exact: true });
    await launcher.getByRole("button", { name: "Company Brain", exact: true }).click();
    const view = brainWindow();
    await view.waitFor();
    expect(await view.getByText("Company Brain", { exact: true }).first().isVisible()).toBe(true);
    const picker = view.getByRole("combobox", { name: "Project" });
    await picker.waitFor();
    expect(await picker.locator("option").allTextContents()).toEqual(["Matrix OS"]);
    const tabs = view.getByRole("tablist", { name: "Screens" }).getByRole("tab");
    expect(await tabs.allTextContents()).toEqual(["Chat", "Today", "Decisions", "Timeline", "Search", "Sources"]);
    expect(await view.getByRole("tab", { name: "Chat", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect(await view.getByRole("heading", { level: 1 }).count()).toBe(0);
    // The stub gateway has no brain routes, so the Chat tab stops at the sources check; the other tabs still work.
    await view.getByText("This part of the Company Brain is not turned on yet.").first().waitFor();
    await view.getByRole("tab", { name: "Search", exact: true }).click();
    await view.getByRole("searchbox", { name: "Search the Company Brain" }).waitFor();
    await page.screenshot({ path: join(evidence, "electron-desktop-ask.png") });

    // The stub gateway has no brain routes, so Sources says the part is not turned on yet.
    await view.getByRole("tab", { name: "Sources", exact: true }).click();
    await view.getByText(/not turned on yet/).first().waitFor();
    await page.screenshot({ path: join(evidence, "electron-desktop-sources.png") });
  }, 60_000);

  it("opens the same single window from the command palette", async () => {
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await palette.waitFor();
    await palette.getByRole("combobox").fill("decisions");
    await palette.getByText("Open Company Brain", { exact: true }).click();
    await brainWindow().waitFor();
    expect(await brainWindow().count()).toBe(1);
  }, 60_000);
});
