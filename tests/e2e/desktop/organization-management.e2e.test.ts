import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { createEvidenceDirectory } from "./fixtures/evidence-directory";
import { startStubGateway } from "./fixtures/stub-gateway";

const root = resolve(__dirname, "../../..");
const main = join(root, "desktop/out/main/index.js");
const suite = existsSync(main) ? describe : describe.skip;
const organization = (organizationId: string, name: string, role: "org:admin" | "org:member", memberCount: number) => ({
  organizationId, name, slug: name.toLowerCase().replaceAll(" ", "-"), role, memberCount,
  aiSubmission: "members", membershipEpoch: 1,
});
const member = (actorId: string, displayName: string, emailAddress: string, role: "org:admin" | "org:member") => ({
  actorId, displayName, emailAddress, role, joinedAt: "2026-10-01T10:00:00.000Z",
});

suite("Electron Desktop organization management", () => {
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  let gateway: Awaited<ReturnType<typeof startStubGateway>>;
  let evidence: ReturnType<typeof createEvidenceDirectory>;

  beforeAll(async () => {
    evidence = createEvidenceDirectory(process.env.MATRIX_ORGANIZATION_EVIDENCE_DIR);
    gateway = await startStubGateway({
      identity: { userId: "user_alex", handle: "alex", displayName: "Alex Rivera" },
      organizationManagement: {
        organizations: [
          organization("org_northwind", "Northwind", "org:admin", 4),
          organization("org_acme", "Acme Studio", "org:member", 4),
        ],
        members: {
          org_northwind: [
            member("user_alex", "Alex Rivera", "alex@northwind.co", "org:admin"),
            member("user_maya", "Maya Chen", "maya@northwind.co", "org:admin"),
            member("user_sam", "Sam Patel", "sam@northwind.co", "org:member"),
            member("user_jordan", "Jordan Lee", "jordan@northwind.co", "org:member"),
          ],
          org_acme: [
            member("user_alex", "Alex Rivera", "alex@northwind.co", "org:member"),
            member("user_maya", "Maya Chen", "maya@northwind.co", "org:admin"),
            member("user_sam", "Sam Patel", "sam@northwind.co", "org:member"),
            member("user_jordan", "Jordan Lee", "jordan@northwind.co", "org:member"),
          ],
        },
        invitations: {
          org_northwind: [{
            invitationId: "orginv_priya", emailAddress: "priya@northwind.co", role: "org:member",
            createdAt: "2026-10-04T10:00:00.000Z", expiresAt: "2026-11-04T10:00:00.000Z",
          }],
          org_acme: [],
        },
      },
    });
    profile = mkdtempSync(join(tmpdir(), "matrix-organization-management-"));
    const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
    app = await _electron.launch({ executablePath, args: [main], env: { ...process.env, OPERATOR_GATEWAY_URL: gateway.url, OPERATOR_USER_DATA_DIR: profile } });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1512, 1127));
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    const organizationSwitcher = page.getByRole("button", { name: /Switch organization/ });
    await organizationSwitcher.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    if (!(await organizationSwitcher.getAttribute("aria-label"))?.includes("Northwind")) {
      await organizationSwitcher.click();
      await page.getByRole("menuitemradio", { name: /Northwind/ }).click();
    }
    await page.getByRole("button", { name: /Switch organization, current organization Northwind/ }).waitFor();
    const checklist = page.getByRole("button", { name: /^Getting started —/ });
    if (await checklist.getAttribute("aria-expanded") === "true") await checklist.click();
    const dusk = readFileSync(join(root, "desktop/out/renderer/wallpapers/matrix-dusk.webp")).toString("base64");
    await page.locator('[data-testid="desktop-background"]').evaluate((element, url) => {
      const target = element as HTMLElement;
      target.style.backgroundImage = `url("${url}")`;
      target.style.backgroundSize = "cover";
      target.style.backgroundPosition = "center";
    }, `data:image/webp;base64,${dusk}`);
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { await gateway?.close(); }
      finally { if (profile) rmSync(profile, { recursive: true, force: true }); evidence?.cleanup(); }
    }
  });

  const capture = (name: string) => page.screenshot({ path: join(evidence.path, name) });
  const switcher = () => page.getByRole("button", { name: /Switch organization/ });
  const settingsWindow = () => page.getByRole("dialog", { name: "Settings window", exact: true });
  const fitSettingsWindow = async () => {
    await settingsWindow().evaluate((element) => {
      const target = element as HTMLElement;
      Object.assign(target.style, { left: "158px", top: "41px", width: "1196px", height: "938px" });
    });
  };
  const openOrganizationSettings = async () => {
    await switcher().click();
    await page.getByRole("menuitem", { name: "Organization settings", exact: true }).click();
    await page.getByRole("heading", { name: "Organization", exact: true }).waitFor();
    await fitSettingsWindow();
  };

  it("captures every live Figma state and exercises a role mutation", async () => {
    await switcher().click();
    await page.getByRole("menuitem", { name: "Organization settings", exact: true }).waitFor();
    await capture("01-organization-switcher.png");
    await page.keyboard.press("Escape");

    await openOrganizationSettings();
    await capture("02-organization-settings.png");
    await settingsWindow().getByRole("button", { name: "Invite members", exact: true }).click();
    const emails = page.getByRole("textbox", { name: "Emails" });
    await emails.fill("sam@northwind.co");
    await emails.press("Enter");
    await emails.fill("lee@northwind.co");
    await emails.press("Enter");
    await capture("03-invite-members.png");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await settingsWindow().getByRole("button", { name: "Close", exact: true }).click();
    await switcher().click();
    await page.getByRole("menuitemradio", { name: /Acme Studio/ }).click();
    await switcher().click();
    await capture("04-member-switcher.png");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await settingsWindow().waitFor();
    const organizationNav = settingsWindow().getByRole("button", { name: "Organization", exact: true });
    if (await organizationNav.count()) await organizationNav.click();
    await page.getByRole("heading", { name: "Organization", exact: true }).waitFor();
    await fitSettingsWindow();
    await capture("05-member-settings.png");
    await settingsWindow().getByRole("button", { name: "Leave Acme Studio", exact: true }).click();
    await capture("06-leave-organization.png");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await settingsWindow().getByRole("button", { name: "Close", exact: true }).click();
    await switcher().click();
    await page.getByRole("menuitemradio", { name: /Northwind/ }).click();
    await openOrganizationSettings();
    await settingsWindow().getByRole("combobox", { name: "Role for Maya Chen", exact: true }).selectOption("org:member");
    await settingsWindow().getByText(/only Admin/).waitFor();
    await capture("07-last-admin.png");
  }, 90_000);
});
