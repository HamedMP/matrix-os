import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const ROOT = resolve(__dirname, "../../..");
const MAIN = join(ROOT, "desktop/out/main/index.js");
const EVIDENCE = join(ROOT, "output/playwright/terminal-sharing-organization");
const electronPath = createRequire(join(ROOT, "desktop/package.json"))("electron") as string;
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(MAIN)) {
  throw new Error("Required Share organization E2E needs desktop/out/main/index.js; run the desktop build first");
}
const suite = existsSync(MAIN) ? describe : describe.skip;

// Spec 535 FR-024 / issue #1798: Electron Desktop has no Clerk session, so the
// trusted core resolves the active organization from the platform listing and
// the Share controls receive it through auth:status.
suite("Electron Desktop Share active organization", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    gateway = await startStubGateway();
    gateway.enableCollaboration("10000000-0000-4000-8000-000000000001");
    gateway.setOrganizations([{ organizationId: "org_matrix_team", name: "Matrix team" }]);
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-share-organization-"));
    app = await _electron.launch({
      executablePath: electronPath,
      args: [MAIN],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userDataDir },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor({ timeout: 15_000 });
    await page.evaluate(async () => { await window.operator.invoke("auth:start-device-flow", {}); });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("resolves the organization in the trusted core with the device credential", async () => {
    await expect.poll(async () => page.evaluate(async () => {
      const status = await window.operator.invoke("auth:status", {}) as { organizationId?: string };
      return status.organizationId ?? null;
    }), { timeout: 15_000 }).toBe("org_matrix_team");
    expect(gateway.state.organizationRequests).toBeGreaterThan(0);
  });

  it("renders an enabled terminal Share control for the selected session", async () => {
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick({ timeout: 15_000 });
    await page.getByRole("button", { name: "Open matrix-task-1" }).click({ timeout: 15_000 });
    const share = page.getByRole("dialog", { name: "Terminal window" }).getByRole("button", { name: "Share terminal" });
    await share.waitFor({ timeout: 15_000 });
    expect(await share.isEnabled()).toBe(true);
    expect((await share.textContent())?.trim()).toBe("Share");
    await page.screenshot({ path: join(EVIDENCE, "electron-desktop-terminal-share.png") });
  });

  it("starts sharing inside the organization instead of asking the user to join one", async () => {
    const share = page.getByRole("dialog", { name: "Terminal window" }).getByRole("button", { name: "Share terminal" });
    await share.click();
    // The stub has no collaboration home, so the attempt ends in the generic
    // unavailable state; reaching it proves the control had an organization.
    const alert = page.getByRole("dialog", { name: "Terminal window" }).getByRole("alert")
      .filter({ hasText: /terminal sharing|organization/i });
    await alert.waitFor({ timeout: 15_000 });
    expect(await alert.textContent()).toContain("Terminal sharing is unavailable");
    expect(await alert.textContent()).not.toContain("Join an organization");
  });
});
