/**
 * Playwright e2e spec for shared-app (spec 062 Wave 5 T081/T085).
 *
 * Requires two running gateway instances (User A and User B) both connected to
 * the same Matrix homeserver. The shell must be running at baseURL.
 *
 * Status: SCAFFOLD — step assertions will be filled in as collab-shell lands
 * T082–T084 (notes app shared mode + share button with data-testid attributes).
 *
 * Known blockers before this suite can go green:
 *   1. collab-shell must add `data-testid` attrs to GroupSwitcher and the
 *      notes app share button (filed in audit log — DM sent to collab-shell).
 *   2. Two-context Clerk auth setup is not wired — E2E_TEST_BYPASS=1 is used
 *      to skip Clerk but that means both contexts share the same gateway
 *      user. True two-user flow requires real Clerk test users or a stub
 *      identity fixture. Documented as MED in audit log.
 *   3. The property test `three peers converge byte-equal after 200 random
 *      mutation sequences` currently times out at 5000ms. Filed as HIGH.
 */
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const BASE_URL = process.env.SHELL_BASE_URL ?? "http://localhost:3000";
const GATEWAY_URL_A = process.env.GATEWAY_URL_A ?? "http://localhost:4000";
const GATEWAY_URL_B = process.env.GATEWAY_URL_B ?? "http://localhost:4001";
const SCREENSHOT_DIR = resolve(__dirname, "screenshots/shared-app");
const TEST_GROUP_SLUG = "test-fam";
const TEST_APP_SLUG = "notes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock gateway API responses so the shell renders without a running backend
 * for pure UI scaffold tests. Real integration tests override these mocks
 * per-step with actual API calls.
 */
async function mockGatewayApis(
  page: Page,
  opts: { groups?: Array<{ slug: string; name: string }> } = {},
) {
  const groups = opts.groups ?? [];
  await page.route("**/api/settings/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        background: { type: "pattern" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
        pinnedApps: [],
        hasKey: true,
      }),
    }),
  );
  await page.route("**/api/identity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ handle: "@a:matrix-os.com", displayName: "User A" }),
    }),
  );
  await page.route("**/api/apps**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );
  await page.route("**/api/groups", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ groups }),
    }),
  );
  await page.route("**/ws/**", (route) => route.abort());
}

async function waitForShell(page: Page) {
  await page.goto(BASE_URL);
  // Wait for dock to confirm shell loaded
  await page.waitForSelector("[data-testid='dock-settings']", { timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Suite: Shared-app flow (two-browser-context)
// ---------------------------------------------------------------------------
test.describe("Shared-app flow (spec 062)", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async () => {
    // Two independent browser contexts = two "users"
    const browser = await chromium.launch();
    contextA = await browser.newContext({
      baseURL: BASE_URL,
      storageState: undefined, // User A — no shared cookies
    });
    contextB = await browser.newContext({
      baseURL: BASE_URL,
      storageState: undefined, // User B — independent session
    });
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
  });

  test.afterAll(async () => {
    await contextA.close();
    await contextB.close();
  });

  // ── Step 1: Setup (both shells load) ──────────────────────────────────────
  test("01 — both shells load", async () => {
    await Promise.all([
      mockGatewayApis(pageA),
      mockGatewayApis(pageB),
    ]);
    await Promise.all([waitForShell(pageA), waitForShell(pageB)]);

    await Promise.all([
      pageA.screenshot({ path: join(SCREENSHOT_DIR, "01-setup-user-a.png") }),
      pageB.screenshot({ path: join(SCREENSHOT_DIR, "01-setup-user-b.png") }),
    ]);
  });

  // ── Step 2: Create group ──────────────────────────────────────────────────
  test("02 — User A creates group", async () => {
    // TODO(T084): Once collab-shell lands the share button and GroupSwitcher
    // data-testid attrs, replace this stub with:
    //   await pageA.getByTestId("group-switcher-trigger").click();
    //   await pageA.getByTestId("group-create-button").click();
    //   await pageA.fill("[data-testid='group-name-input']", "Test Fam");
    //   await pageA.getByTestId("group-create-confirm").click();
    //   await expect(pageA.getByTestId("group-switcher-trigger")).toContainText("Test Fam");
    //
    // For now: verify GroupSwitcher trigger button renders (aria-haspopup=listbox)
    await mockGatewayApis(pageA, {
      groups: [{ slug: TEST_GROUP_SLUG, name: "Test Fam" }],
    });
    await pageA.goto(BASE_URL);
    await pageA.waitForSelector("[aria-haspopup='listbox']", { timeout: 10_000 });
    await pageA.screenshot({ path: join(SCREENSHOT_DIR, "02-group-switcher.png") });
  });

  // ── Step 3: Join invite ───────────────────────────────────────────────────
  test("03 — User B sees group after join", async () => {
    // TODO(T084): Replace stub with real Matrix invite flow once notes app
    // shared mode is wired. Currently the Matrix join_group IPC tool is
    // tested in kernel unit tests; this e2e test is a placeholder.
    await mockGatewayApis(pageB, {
      groups: [{ slug: TEST_GROUP_SLUG, name: "Test Fam" }],
    });
    await pageB.goto(BASE_URL);
    await pageB.waitForSelector("[aria-haspopup='listbox']", { timeout: 10_000 });
    await pageB.screenshot({ path: join(SCREENSHOT_DIR, "03-user-b-joined.png") });
  });

  // ── Step 4: Share app ─────────────────────────────────────────────────────
  test("04 — User A shares notes app", async () => {
    // TODO(T084): Replace with:
    //   await pageA.getByTestId("app-notes-share-button").click();
    //   await pageA.getByTestId("share-with-group-test-fam").click();
    //   await pageA.getByTestId("share-confirm").click();
    //   await expect(...).toContainText("Shared with Test Fam");
    //
    // Blocker: collab-shell T084 share button not yet landed.
    // Failing clearly rather than silently — see test comment in spec header.
    test.skip(true, "Blocked on collab-shell T084: notes share button not yet implemented");
  });

  // ── Step 5: B accepts install ─────────────────────────────────────────────
  test("05 — User B accepts app install prompt", async () => {
    test.skip(true, "Blocked on collab-shell T084: app install prompt not yet implemented");
  });

  // ── Step 6: Live edit A → B ───────────────────────────────────────────────
  test("06 — A creates note, B sees it within 2s", async () => {
    test.skip(true, "Blocked on collab-shell T083/T084: notes shared mode not yet implemented");
  });

  // ── Step 7: Live edit B → A ───────────────────────────────────────────────
  test("07 — B edits note, A sees it within 2s", async () => {
    test.skip(true, "Blocked on collab-shell T083/T084");
  });

  // ── Step 8: Offline edit replay ───────────────────────────────────────────
  test("08 — A goes offline, edits 5 times, reconnects; all edits replay to B", async () => {
    // Partial scaffold — offline toggle is feasible via context.setOffline()
    // but the notes app assertions still need T083/T084.
    test.skip(true, "Blocked on collab-shell T083/T084 (assertion side); offline toggle ready");
  });

  // ── Step 9: Crash recovery (optional) ────────────────────────────────────
  test("09 — Crash recovery: A restarts mid-edit, state recovers", async () => {
    test.skip(true, "Optional: Playwright cannot reliably simulate gateway crashes. Covered by unit tests.");
  });
});

// ---------------------------------------------------------------------------
// Suite: API smoke (uses existing vitest-style gateway fixtures via HTTP)
// ---------------------------------------------------------------------------
test.describe("Group API smoke (Playwright HTTP layer)", () => {
  test("GET /api/groups returns 401 without auth", async ({ request }) => {
    const resp = await request.get(`${GATEWAY_URL_A}/api/groups`);
    expect(resp.status()).toBe(401);
  });

  test("POST /api/groups returns 401 without auth", async ({ request }) => {
    const resp = await request.post(`${GATEWAY_URL_A}/api/groups`, {
      data: { name: "test" },
    });
    expect(resp.status()).toBe(401);
  });

  test("POST /api/groups/join returns 401 without auth", async ({ request }) => {
    const resp = await request.post(`${GATEWAY_URL_A}/api/groups/join`, {
      data: { room_id: "!abc:example.com" },
    });
    expect(resp.status()).toBe(401);
  });
});
