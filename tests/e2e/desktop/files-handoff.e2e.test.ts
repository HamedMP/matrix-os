import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const EVIDENCE_DIR = resolve(__dirname, "../../../docs/pr-evidence");
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

suite("MAT-298 Files handoff in Electron", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "mat-298-files-"));
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [DESKTOP_MAIN],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.locator("aside button", { hasText: "Files" }).first().waitFor({ timeout: 15_000 });
    await page.locator("aside button", { hasText: "Files" }).first().click();
    await page.getByRole("heading", { name: "Files" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open workspaces" }).waitFor({ timeout: 10_000 });
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch (error: unknown) {
      console.warn("[mat-298 e2e] Electron cleanup failed:", error instanceof Error ? error.message : String(error));
    }
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("captures the full-width list and grid overview states", async () => {
    expect(await page.getByRole("region", { name: "File preview" }).count()).toBe(0);
    await page.screenshot({ path: join(EVIDENCE_DIR, "mat-298-files-list.png") });

    await page.getByRole("button", { name: "Grid view" }).click();
    expect(await page.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
    await page.screenshot({ path: join(EVIDENCE_DIR, "mat-298-files-grid.png") });
  });

  it("captures selected-folder preview and managed read-only states", async () => {
    await page.getByRole("button", { name: "Open workspaces" }).click();
    await page.getByRole("region", { name: "File preview" }).waitFor();
    await page.getByRole("heading", { name: "workspaces" }).waitFor();
    await page.getByText("matrix-os").waitFor();
    await page.screenshot({ path: join(EVIDENCE_DIR, "mat-298-files-folder-preview.png") });

    await page.getByRole("button", { name: "Open SOUL.md" }).click();
    await page.getByRole("region", { name: "File preview" }).getByText("Matrix OS is your AI operating system.").waitFor();
    await page.screenshot({ path: join(EVIDENCE_DIR, "mat-298-files-file-preview.png") });

    await page.getByRole("button", { name: "Open system" }).click();
    await page.getByText("Managed · Read only").waitFor();
    await page.getByRole("button", { name: "Open system" }).dblclick();
    await page.getByText("Read only", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Upload files" }).count()).toBe(0);
    await page.screenshot({ path: join(EVIDENCE_DIR, "mat-298-files-managed.png") });
  });
});
