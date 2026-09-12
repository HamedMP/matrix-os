import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startDownloadGateway } from "./fixtures/download-gateway";

const desktopMain = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const executablePath = desktopRequire("electron") as string;

describe("OM-243 built Electron download", () => {
  let gateway: Awaited<ReturnType<typeof startDownloadGateway>>;
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  let destinationDir: string;

  async function launch() {
    return _electron.launch({ executablePath, args: [desktopMain], env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: userData } });
  }
  beforeAll(async () => {
    gateway = await startDownloadGateway();
    userData = await mkdtemp(join(tmpdir(), "om-243-electron-"));
    destinationDir = await mkdtemp(join(tmpdir(), "om-243-saved-"));
    app = await launch();
    // Seed only a synthetic fixture credential using Electron encryption. No
    // external authentication flow or real user profile is opened or modified.
    const encrypted = await app.evaluate(({ safeStorage }) => Array.from(safeStorage.encryptString(JSON.stringify({ accessToken: "stub-token-1", expiresAt: Date.now() + 3_600_000, userId: "fixture-user", handle: "fixture" }))));
    await writeFile(join(userData, "credential.bin"), Buffer.from(encrypted));
    await writeFile(join(userData, "state.json"), JSON.stringify({ profile: { platformHost: gateway.url, runtimeSlot: "primary", userId: "fixture-user", handle: "fixture" } }));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId("desktop-taskbar-files").click({ timeout: 20_000 });
    await page.getByRole("button", { name: `Open ${gateway.filename}` }).waitFor();
    // The fixture auto-opens onboarding over the preview header.
    if (await page.getByRole("dialog", { name: "Getting started", exact: true }).isVisible()) {
      await page.getByRole("button", { name: /^Getting started —/ }).click();
    }
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      await gateway?.close();
      if (userData) await rm(userData, { recursive: true, force: true });
      if (destinationDir) await rm(destinationDir, { recursive: true, force: true });
    }
  });

  it("saves identical 64 MiB binary bytes through preview and context menu", async () => {
    const destination = join(destinationDir, gateway.filename);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async (_window, options) => {
        if (!options?.properties?.includes("showOverwriteConfirmation")) throw new Error("overwrite confirmation missing");
        return { canceled: false, filePath };
      };
    }, destination);
    await page.getByRole("button", { name: `Open ${gateway.filename}` }).click();
    await page.getByText("Preview not available").waitFor();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await page.getByText("Download saved.", { exact: true }).waitFor();
    expect(createHash("sha256").update(await readFile(destination)).digest("hex")).toBe(gateway.sha256);
    expect(await readdir(destinationDir)).toEqual([gateway.filename]);
    await page.getByRole("button", { name: "Dismiss download status" }).click();
    await page.getByRole("button", { name: `Open ${gateway.filename}` }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Download", exact: true }).click();
    await page.getByText("Download saved.", { exact: true }).waitFor();
    expect(createHash("sha256").update(await readFile(destination)).digest("hex")).toBe(gateway.sha256);
    expect(gateway.requestCount()).toBe(2);
  });

  it("treats native save-dialog cancellation as a non-error without fetching", async () => {
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
    await page.getByRole("button", { name: "File actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Download", exact: true }).click();
    await page.getByText("Download cancelled.", { exact: true }).waitFor();
    expect(gateway.requestCount()).toBe(2);
  });
  it("resumes a dropped real HTTP response and still saves the complete file", async () => {
    const destination = join(destinationDir, gateway.filename);
    const before = gateway.requestCount();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    gateway.interruptNextDownload();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await page.getByText("Download saved.", { exact: true }).waitFor();
    expect(createHash("sha256").update(await readFile(destination)).digest("hex")).toBe(gateway.sha256);
    expect(gateway.requestCount()).toBe(before + 2);
    expect(await readdir(destinationDir)).toEqual([gateway.filename]);
  });

});
