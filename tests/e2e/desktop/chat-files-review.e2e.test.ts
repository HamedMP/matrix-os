import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeElectronApp } from "./fixtures/close-electron";
import { dismissGettingStartedOnInteraction } from "./fixtures/getting-started";
import {
  MATRIX_ATTACH_FILE, MATRIX_TRASH_CHILD, MATRIX_TRASH_FOLDER, startChatFilesReviewGateway,
} from "./fixtures/chat-files-review-gateway";

const root = resolve(__dirname, "../../..");
const built = existsSync(join(root, "desktop/out/main/index.js"));
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built) throw new Error("Required Desktop build missing");
const suite = built ? describe : describe.skip;
const evidence = process.env.ENG507_REVIEW_OUTPUT;

async function capture(page: Page, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name) });
}

suite("Chat attach and recoverable Files Trash in Electron Desktop", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let gateway: Awaited<ReturnType<typeof startChatFilesReviewGateway>>;

  beforeAll(async () => {
    gateway = await startChatFilesReviewGateway();
    profile = await mkdtemp(join(tmpdir(), "electron-chat-files-review-"));
    const launch = () => _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [resolve(__dirname, "fixtures/canonical-input-electron.mjs")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    app = await launch();
    const encrypted = await app.evaluate(async ({ app: electron, safeStorage }) => {
      await electron.whenReady();
      return safeStorage.encryptString(JSON.stringify({
        accessToken: "stub-token-1",
        expiresAt: Date.now() + 3_600_000,
        userId: "user-1",
        handle: "neo",
      })).toString("base64");
    });
    await writeFile(join(profile, "credential.bin"), Buffer.from(encrypted, "base64"));
    await closeElectronApp(app);
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await dismissGettingStartedOnInteraction(page);
    page.setDefaultTimeout(12_000);
  }, 60_000);

  afterAll(async () => {
    try {
      if (page && !page.isClosed()) await capture(page, "electron-last-state.png");
    } finally {
      if (app) await closeElectronApp(app);
      await gateway?.close();
      if (profile) await rm(profile, { recursive: true, force: true });
    }
  });

  it("picks and drags Matrix files and still accepts local file selection", async () => {
    await page.getByRole("button", { name: "Chat", exact: true }).first().dblclick();
    const done = page.getByRole("button", { name: "Done", exact: true });
    if (await done.getAttribute("aria-expanded") === "false") await done.click();
    await page.getByRole("button", { name: "Chat Files review", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Reply to chat", exact: true });
    await composer.waitFor();
    await page.getByRole("button", { name: "Attach files", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Attach files" });
    const select = picker.getByRole("button", { name: `Attach ${MATRIX_ATTACH_FILE}`, exact: true });
    await select.waitFor();
    await capture(page, "electron-matrix-attachment-picker.png");
    await select.click();
    await page.getByRole("button", { name: `Remove ${MATRIX_ATTACH_FILE}`, exact: true }).waitFor();
    await capture(page, "electron-matrix-attached.png");
    await page.getByLabel("Choose files", { exact: true }).setInputFiles({
      name: "local-fixture.txt", mimeType: "text/plain", buffer: Buffer.from("Local attachment"),
    });
    await page.getByRole("button", { name: "Remove local-fixture.txt", exact: true }).waitFor();
    await capture(page, "electron-matrix-and-local-attached.png");
    await page.getByRole("button", { name: `Remove ${MATRIX_ATTACH_FILE}`, exact: true }).click();
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await page.getByRole("button", { name: "Show inspector", exact: true }).click();
    const row = page.getByRole("region", { name: "Files", exact: true }).getByRole("button", { name: `Open file ${MATRIX_ATTACH_FILE}`, exact: true });
    await row.dragTo(composer);
    await page.getByRole("button", { name: `Remove ${MATRIX_ATTACH_FILE}`, exact: true }).waitFor();
    await capture(page, "electron-matrix-drag-attached.png");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: `Move to Trash ${MATRIX_ATTACH_FILE}`, exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Move to Trash" });
    await confirmation.getByText(MATRIX_ATTACH_FILE, { exact: true }).waitFor();
    await capture(page, "electron-inspector-trash-confirmation.png");
    await confirmation.getByRole("button", { name: "Move to Trash", exact: true }).click();
    await row.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open Trash", exact: true }).click();
    const restored = page.getByRole("button", { name: `Restore ${MATRIX_ATTACH_FILE}`, exact: true });
    await restored.click();
    await restored.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Close Trash", exact: true }).click();
    await row.waitFor();
    await page.getByRole("button", { name: "Restore Chat as window", exact: true }).click();
  });

  it("moves a disposable folder to Trash and restores its bytes", async () => {
    await page.getByTestId("desktop-taskbar-files").click();
    const folder = page.getByRole("button", { name: `Open ${MATRIX_TRASH_FOLDER}`, exact: true });
    await folder.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Move to Trash" });
    await confirm.getByText(MATRIX_TRASH_FOLDER, { exact: true }).waitFor();
    await capture(page, "electron-trash-confirmation.png");
    await confirm.getByRole("button", { name: "Move to Trash", exact: true }).click();
    await folder.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open Trash", exact: true }).click();
    const restore = page.getByRole("button", { name: `Restore ${MATRIX_TRASH_FOLDER}`, exact: true });
    await restore.waitFor();
    await capture(page, "electron-trash-restore.png");
    await restore.click();
    await restore.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Close Trash", exact: true }).click();
    await folder.waitFor();
    expect(await readFile(join(gateway.homePath, MATRIX_TRASH_FOLDER, "child.txt"), "utf8")).toBe(MATRIX_TRASH_CHILD);
  });
});
