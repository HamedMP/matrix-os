import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const output = join(root, "output/playwright/signin-brand");
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !existsSync(main)) {
  throw new Error("Required desktop build is missing");
}
const suite = existsSync(main) ? describe : describe.skip;

suite("Electron Desktop branded account entry", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;

  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    profile = mkdtempSync(join(tmpdir(), "matrix-signin-brand-"));
    app = await _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [main],
      env: { ...process.env, OPERATOR_USER_DATA_DIR: profile },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Create account", exact: true }).waitFor();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800);
      // Exercise the real renderer/preload bridge without creating an account
      // or opening a browser on the operator's computer.
      for (const channel of ["auth:start-device-flow", "auth:poll", "shell:open-external"]) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle("auth:start-device-flow", (_event, { intent }) => ({
        userCode: "ABCD-EFGH",
        verificationUri: `https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH&mode=${intent}`,
        expiresIn: 2700,
      }));
      ipcMain.handle("auth:poll", () => ({ status: "pending" }));
      ipcMain.handle("shell:open-external", () => undefined);
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("bundles the brand fonts and wallpaper and keeps both account intents", async () => {
    expect(await page.locator("body").innerText()).not.toMatch(/electron|VPS|Stripe/i);
    await page.getByRole("heading", { name: "Welcome to Matrix OS", exact: true }).waitFor();
    const assets = await page.evaluate(async () => {
      await document.fonts.ready;
      const wallpaper = document.querySelector<HTMLImageElement>(".signin-wallpaper")!;
      return {
        loaded: wallpaper.complete && wallpaper.naturalWidth > 0,
        font: getComputedStyle(document.querySelector("h1")!).fontFamily,
        fontFaces: Array.from(document.fonts).filter((font) => font.status === "loaded").map((font) => font.family),
      };
    });
    expect(assets.loaded).toBe(true);
    expect(assets.font).toContain("Bricolage Grotesque");
    expect(assets.fontFaces.join(" ")).toContain("Bricolage Grotesque");
    expect(assets.fontFaces.join(" ")).toContain("Geist");
    await page.screenshot({ path: join(output, "welcome.png") });

    for (const [action, description] of [["Create account", "Create your account"], ["Sign in", "Sign in"]]) {
      await page.getByRole("button", { name: action, exact: true }).click();
      await page.getByText(`${description} in your browser. We'll bring you back here when you're ready.`, { exact: true }).waitFor();
      expect(await page.locator(".signin-code").innerText()).toBe("ABCD-EFGH");
      await page.getByRole("button", { name: "Open browser again", exact: true }).click();
      expect(await page.locator("body").innerText()).not.toMatch(/electron/i);
      await page.screenshot({ path: join(output, action === "Sign in" ? "sign-in-approval.png" : "create-account-approval.png") });
      await page.reload();
      await page.getByRole("button", { name: "Create account", exact: true }).waitFor();
    }
  });

  it("keeps approval reachable and avoids overflow in a narrow window", async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(640, 720));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const reopen = page.getByRole("button", { name: "Open browser again", exact: true });
    await reopen.click(); // Playwright scrolls the actual scroll container.
    const geometry = await page.locator(".signin").evaluate((element) => ({
      overflow: getComputedStyle(element).overflowY,
      scroll: element.scrollHeight,
      height: element.clientHeight,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.overflow).toBe("auto");
    expect(geometry.scroll).toBeGreaterThan(geometry.height);
    expect(geometry.scrollWidth).toBe(geometry.width);
    await page.screenshot({ path: join(output, "narrow-approval.png") });
  });
});
