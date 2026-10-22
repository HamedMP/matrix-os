import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";
import { createEvidenceDirectory } from "./fixtures/evidence-directory";
import { dismissGettingStartedOnInteraction } from "./fixtures/getting-started";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
const suite = existsSync(main) ? describe : describe.skip;

// Gateway journal/authorization/cascade behavior is covered by shared-project-deletion.test.ts.
// This drives the actual built Electron renderer and checks its successful-deletion refresh.
suite("Electron Desktop project deletion", () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let gateway: StubGateway;
  let userData: string;
  let evidence: ReturnType<typeof createEvidenceDirectory>;

  beforeAll(async () => {
    evidence = createEvidenceDirectory(process.env.MATRIX_EVIDENCE_DIR);
    userData = await mkdtemp(join(tmpdir(), "matrix-project-delete-electron-"));
    gateway = await startStubGateway();
    app = await _electron.launch({ executablePath, args: [main], env: {
      ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userData,
    } });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: "Help", exact: true }).waitFor({ timeout: 20_000 });
    await dismissGettingStartedOnInteraction(page);
    await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Actions for Matrix OS", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      await gateway?.close();
      if (userData) await rm(userData, { recursive: true, force: true });
      evidence?.cleanup();
    }
  });

  it("requires exact confirmation and refreshes shared discovery after successful deletion", async () => {
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-project-discovery-refreshes", "0");
      window.addEventListener("matrix:collaboration-discovery-changed", () => {
        const count = Number(document.documentElement.getAttribute("data-project-discovery-refreshes"));
        document.documentElement.setAttribute("data-project-discovery-refreshes", String(count + 1));
      });
    });
    await page.screenshot({ path: join(evidence.path, "electron-project-before-delete.png") });
    const actions = page.getByRole("button", { name: "Actions for Matrix OS", exact: true });
    await actions.focus();
    await actions.press("Enter", { timeout: 10_000 });
    await page.getByRole("menuitem", { name: "Delete project", exact: true }).click({ timeout: 10_000 });
    const dialog = page.getByRole("alertdialog", { name: "Delete project permanently?" });
    await dialog.waitFor({ timeout: 10_000 });
    const submit = dialog.getByRole("button", { name: "Delete project", exact: true });
    expect(await submit.isEnabled()).toBe(false);
    await dialog.getByLabel("Type Matrix OS to confirm").fill("Matrix OS", { timeout: 10_000 });
    expect(await submit.isEnabled()).toBe(true);
    await page.screenshot({ path: join(evidence.path, "electron-delete-confirmation.png") });
    await submit.click();
    await dialog.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByRole("button", { name: "Actions for Matrix OS", exact: true }).waitFor({ state: "detached" });
    expect(await page.locator("html").getAttribute("data-project-discovery-refreshes")).toBe("1");
    await page.screenshot({ path: join(evidence.path, "electron-project-deleted.png") });
  }, 60_000);
});
