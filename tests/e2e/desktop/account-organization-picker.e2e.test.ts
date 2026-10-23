import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const desktopMain = join(root, "desktop/out/main/index.js");
const hasDesktopBuild = existsSync(desktopMain);
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !hasDesktopBuild) {
  throw new Error("Required Desktop E2E build is missing");
}
const suite = hasDesktopBuild ? describe : describe.skip;

suite("Electron Desktop account organization picker", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let gateway: Awaited<ReturnType<typeof startStubGateway>>;

  beforeAll(async () => {
    gateway = await startStubGateway({
      identity: { userId: "user_picker", handle: "picker", displayName: "Picker Member" },
      organizationManagement: { organizations: [
        { organizationId: "org_alpha", name: "Alpha", slug: "alpha", role: "org:member", memberCount: 2, aiSubmission: "members", membershipEpoch: 1 },
        { organizationId: "org_matrix", name: "Matrix Main", slug: "matrix-main", role: "org:member", memberCount: 4, aiSubmission: "members", membershipEpoch: 1 },
        ...Array.from({ length: 18 }, (_, index) => ({ organizationId: `org_extra_${index}`, name: `Organization ${index + 1}`, slug: `extra-${index}`, role: "org:member", memberCount: 2, aiSubmission: "members" as const, membershipEpoch: 1 })),
      ], members: {}, invitations: {} },
    });
    profile = mkdtempSync(join(tmpdir(), "matrix-account-picker-"));
    app = await _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [desktopMain],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("button", { name: "Open account menu", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterEach(async () => { await page?.keyboard.press("Escape"); });

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { await gateway?.close(); }
      finally { if (profile) rmSync(profile, { recursive: true, force: true }); }
    }
  });

  it("keeps the last organization and account actions reachable in a short viewport", async () => {
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Account", exact: true });
    await menu.waitFor();
    const bounds = await menu.evaluate((element) => ({
      top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom,
      viewport: window.innerHeight, scrolls: element.scrollHeight > element.clientHeight,
    }));
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.scrolls).toBe(true);
    for (const item of [page.getByRole("menuitemradio", { name: "Organization 18", exact: true }), page.getByRole("menuitem", { name: "Settings", exact: true }), page.getByRole("menuitem", { name: "Log out", exact: true })]) {
      await item.scrollIntoViewIfNeeded();
      const visible = await item.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
      });
      expect(visible).toBe(true);
    }
    await page.keyboard.press("Escape");
  }, 30_000);

  it("switches through the existing account menu and preserves its active selection when reopened", async () => {
    const trigger = page.getByRole("button", { name: "Open account menu", exact: true });
    await trigger.click();
    const selected = page.getByRole("menuitemradio", { name: "Matrix Main", exact: true });
    await selected.click();
    expect(await selected.getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("Escape");
    await trigger.click();
    expect(await selected.getAttribute("aria-checked")).toBe("true");
    await page.screenshot({ path: join(profile, "account-picker.png") });
  }, 30_000);
});
