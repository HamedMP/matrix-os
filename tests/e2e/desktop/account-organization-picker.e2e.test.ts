import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");

describe("Electron Desktop account organization picker", () => {
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
      ], members: {}, invitations: {} },
    });
    profile = mkdtempSync(join(tmpdir(), "matrix-account-picker-"));
    app = await _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.getByRole("button", { name: "Open account menu", exact: true }).waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { await gateway?.close(); }
      finally { if (profile) rmSync(profile, { recursive: true, force: true }); }
    }
  });

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
