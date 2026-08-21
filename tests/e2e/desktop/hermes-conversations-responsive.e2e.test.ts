import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const DESKTOP_MAIN = resolve(__dirname, "../../../desktop/out/main/index.js");
const desktopRequire = createRequire(resolve(__dirname, "../../../desktop/package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-299-responsive");
const MAT_322_SCREENSHOT_DIR = resolve(__dirname, "../../../output/playwright/mat-322");
const MINIMUM_VIEWPORT = { width: 880, height: 560 } as const;
const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

async function measureOverflow(root: Locator) {
  return root.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const visibleElements = [element, ...element.querySelectorAll<HTMLElement>("*")]
      .filter((candidate) => {
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
      });

    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      outside: visibleElements
        .map((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return {
            label: candidate.getAttribute("aria-label"),
            text: (candidate.textContent ?? "").trim().slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          };
        })
        .filter(({ left, right }) => left < Math.floor(rootRect.left) || right > Math.ceil(rootRect.right)),
    };
  });
}

function expectNoHorizontalOverflow(measurement: Awaited<ReturnType<typeof measureOverflow>>) {
  expect(measurement.outside).toEqual([]);
  expect(measurement.scrollWidth).toBe(measurement.clientWidth);
}

suite("responsive Hermes Desktop conversations", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    mkdirSync(MAT_322_SCREENSHOT_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "mat-299-responsive-"));
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
    await page.setViewportSize(MINIMUM_VIEWPORT);
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
    await page.locator("aside button", { hasText: "Chat" }).first().waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("keeps Chat and Files toolbar actions visible at the Figma handoff viewport", async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    expectNoHorizontalOverflow(await measureOverflow(page.locator("[data-chat-index-header]")));

    await page.locator("aside button", { hasText: "Files" }).first().click();
    await page.getByRole("heading", { name: "Files" }).waitFor({ timeout: 10_000 });
    expectNoHorizontalOverflow(await measureOverflow(page.getByTestId("files-home-content")));

    await page.setViewportSize(MINIMUM_VIEWPORT);
  }, 30_000);

  it("keeps Chats lifecycle surfaces inside the minimum Desktop viewport", async () => {
    await page.locator("aside button", { hasText: "Chat" }).first().click();

    const chats = page.locator('section[aria-labelledby="conversation-index-title"]');
    await page.getByRole("heading", { name: "Chats" }).waitFor({ timeout: 10_000 });
    const indexOverflow = await measureOverflow(chats);

    await page.getByRole("button", { name: "Search chats" }).click();
    await page.getByRole("searchbox", { name: "Search chats" }).fill("provider");
    const searchOverflow = await measureOverflow(chats);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-minimum-window-search.png") });

    await page.getByRole("button", { name: "Close search" }).click();
    const providerRow = page.getByRole("button", {
      name: "Verify provider switching remains intact conversation",
    });
    await providerRow.click();
    const conversation = page.getByRole("region", { name: "Hermes conversation" });
    await conversation.waitFor();
    const conversationOverflow = await measureOverflow(conversation);
    await page.getByRole("button", { name: "Resources" }).click();
    const resources = page.getByRole("complementary", { name: "Resources" });
    await resources.waitFor();
    const resourcesOverflow = await measureOverflow(conversation);
    await page.screenshot({ path: join(MAT_322_SCREENSHOT_DIR, "05-resources-constrained.png") });
    await page.getByRole("button", { name: "Close Resources" }).click();

    await page.locator("aside button", { hasText: "Chat" }).first().click();
    await providerRow.hover();
    await page.getByRole("button", {
      name: "Delete Verify provider switching remains intact",
    }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Delete Verify provider switching remains intact?",
    });
    await dialog.waitFor();
    const dialogOverflow = await measureOverflow(dialog);

    expectNoHorizontalOverflow(indexOverflow);
    expectNoHorizontalOverflow(searchOverflow);
    expectNoHorizontalOverflow(conversationOverflow);
    expectNoHorizontalOverflow(resourcesOverflow);
    expectNoHorizontalOverflow(dialogOverflow);
    await page.keyboard.press("Escape");
  }, 30_000);

  it("keeps every Files home toolbar control inside the minimum Desktop viewport", async () => {
    await page.locator("aside button", { hasText: "Files" }).first().click();
    await page.getByRole("heading", { name: "Files" }).waitFor({ timeout: 10_000 });

    const files = page.getByTestId("files-home-content");
    const filesOverflow = await measureOverflow(files);

    expectNoHorizontalOverflow(filesOverflow);
    expect(await page.getByRole("button", { name: "Grid view" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "List view" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Search files" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Upload files" }).count()).toBe(1);
  }, 30_000);
});
