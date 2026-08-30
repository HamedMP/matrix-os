import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const REPOSITORY_ROOT = resolve(__dirname, "../../..");
const DESKTOP_ROOT = join(REPOSITORY_ROOT, "desktop");
const DESKTOP_MAIN = join(DESKTOP_ROOT, "out/main/index.js");
const desktopRequire = createRequire(join(DESKTOP_ROOT, "package.json"));
const ELECTRON_EXECUTABLE = desktopRequire("electron") as string;
const EVIDENCE_DIR = join(REPOSITORY_ROOT, "output/playwright/terminal-clipboard");
const REQUIRED = process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1";

if (REQUIRED && !existsSync(DESKTOP_MAIN)) {
  throw new Error("Required terminal clipboard E2E needs desktop/out/main/index.js; run the desktop build first");
}

const suite = existsSync(DESKTOP_MAIN) ? describe : describe.skip;

interface CellPoint {
  x: number;
  y: number;
}

suite("packaged Electron terminal clipboard", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let activeSessionName: "matrix-task-1" | "matrix-review" = "matrix-task-1";
  const copyShortcut = process.platform === "darwin" ? "Meta+C" : "Control+Shift+C";
  const alternateCopyShortcut = process.platform === "darwin" ? "Meta+Shift+C" : copyShortcut;
  const pasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+Shift+V";

  const terminalSurface = () => page
    .getByRole("heading", { name: activeSessionName, exact: true })
    .locator("xpath=ancestor::section[1]")
    .locator("[data-terminal-surface]");

  async function clipboardText(): Promise<string> {
    return app.evaluate(({ clipboard }) => clipboard.readText());
  }

  async function writeClipboard(text: string): Promise<void> {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  }

  async function terminalPoint(text: string, characterIndex: number): Promise<CellPoint> {
    const surface = terminalSurface();
    const row = surface.locator('.xterm-accessibility-tree [role="listitem"]', { hasText: text }).last();
    await row.waitFor({ timeout: 10_000 });
    const [rowText, rowBox, screenBox] = await Promise.all([
      row.textContent(),
      row.boundingBox(),
      surface.locator(".xterm-screen").boundingBox(),
    ]);
    if (!rowText || !rowBox || !screenBox) throw new Error("terminal row geometry is unavailable");
    const start = rowText.indexOf(text);
    if (start < 0) throw new Error("synthetic text is absent from the terminal row");
    const resize = gateway.state.terminalResizeEvents.findLast(
      (event) => event.session === activeSessionName,
    );
    if (!resize) throw new Error("terminal column count is unavailable");
    const cellWidth = screenBox.width / resize.cols;
    return {
      x: screenBox.x + (start + characterIndex + 0.5) * cellWidth,
      y: rowBox.y + rowBox.height / 2,
    };
  }

  async function selectBetween(
    startText: string,
    startIndex: number,
    endText: string,
    endIndexExclusive: number,
  ): Promise<void> {
    const start = await terminalPoint(startText, startIndex);
    const end = await terminalPoint(endText, endIndexExclusive);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
  }

  async function openSession(name: string): Promise<void> {
    const currentHeading = page.getByRole("heading", { name });
    if (await currentHeading.isVisible().catch(() => false)) return;
    const terminalBreadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "Terminal" });
    if (await terminalBreadcrumb.isVisible().catch(() => false)) await terminalBreadcrumb.click();
    await page.getByRole("button", { name: `Open ${name}` }).click();
    await currentHeading.waitFor({ timeout: 10_000 });
    activeSessionName = name as "matrix-task-1" | "matrix-review";
    await terminalSurface().locator(".xterm-helper-textarea").focus();
  }

  beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-terminal-clipboard-"));
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [DESKTOP_MAIN],
      artifactsDir: EVIDENCE_DIR,
      recordVideo: { dir: EVIDENCE_DIR, size: { width: 1280, height: 720 } },
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.getByRole("button", { name: /continue in browser/i }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
    await openSession("matrix-task-1");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("preserves exact selections and routes copy/paste to only the focused terminal", async () => {
    const firstLine = "CLIP-FIRST Unicode αβγ";
    const secondLine = "CLIP-SECOND plain multiline END";
    const exactSelection = `${firstLine}\n${secondLine}`;
    const wrappedLine = `WRAPPED-${"0123456789".repeat(12)}-END`;
    gateway.sendTerminalOutput(`\r\n${firstLine}\r\n${secondLine}\r\n${wrappedLine}\r\n`);
    await terminalSurface().getByText(secondLine, { exact: false }).waitFor({ timeout: 10_000 });

    await selectBetween(firstLine, 0, secondLine, secondLine.length);
    await page.keyboard.press(copyShortcut);
    await expect.poll(clipboardText).toBe(exactSelection);
    await page.keyboard.press(alternateCopyShortcut);
    await expect.poll(clipboardText).toBe(exactSelection);

    const rightClickTrials = [
      {
        startText: firstLine,
        startIndex: 0,
        endText: secondLine,
        endIndex: secondLine.length,
        clickText: firstLine,
        clickIndex: 2,
        expected: exactSelection,
      },
      {
        startText: secondLine,
        startIndex: 0,
        endText: secondLine,
        endIndex: secondLine.length,
        clickText: secondLine,
        clickIndex: 4,
        expected: secondLine,
      },
      {
        startText: "WRAPPED-",
        startIndex: 0,
        endText: "-END",
        endIndex: 4,
        clickText: "WRAPPED-",
        clickIndex: 3,
        expected: wrappedLine,
      },
    ] as const;
    for (let trial = 0; trial < 50; trial += 1) {
      const scenario = rightClickTrials[trial % rightClickTrials.length]!;
      await selectBetween(
        scenario.startText,
        scenario.startIndex,
        scenario.endText,
        scenario.endIndex,
      );
      const selectionPoint = await terminalPoint(scenario.clickText, scenario.clickIndex);
      await page.mouse.click(selectionPoint.x, selectionPoint.y, { button: "right" });
      const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
      await copy.waitFor();
      expect(await copy.isEnabled()).toBe(true);
      if (trial === 0) {
        await page.screenshot({ path: join(EVIDENCE_DIR, "terminal-selection-copy-enabled.png") });
        await writeClipboard("stale clipboard value");
      }
      await copy.click();
      await expect.poll(clipboardText).toBe(scenario.expected);
    }

    const pastePayload = "paste-once-no-enter";
    const inputCount = gateway.state.terminalInputs.length;
    await writeClipboard(pastePayload);
    await terminalSurface().locator(".xterm-helper-textarea").focus();
    await page.keyboard.press(pasteShortcut);
    await expect.poll(() => gateway.state.terminalInputs.slice(inputCount)).toEqual([pastePayload]);
    expect(gateway.state.terminalInputs.slice(inputCount).join("")).not.toContain("\r");

    gateway.sendTerminalOutput("\u001b[?1003h\u001b[?1006h");
    const screen = terminalSurface().locator(".xterm-screen");
    const screenBox = await screen.boundingBox();
    if (!screenBox) throw new Error("terminal screen geometry is unavailable");
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+A");
    } else {
      await page.mouse.click(screenBox.x + 30, screenBox.y + 30, { button: "right" });
      await page.getByRole("menuitem", { name: "Select All", exact: true }).click();
    }
    await page.keyboard.press(copyShortcut);
    await expect.poll(clipboardText).toContain(firstLine);
    const selectAllSnapshot = await clipboardText();
    for (let move = 0; move < 20; move += 1) {
      await page.mouse.move(
        screenBox.x + 10 + ((move * 31) % Math.max(20, screenBox.width - 20)),
        screenBox.y + 10 + ((move * 17) % Math.max(20, screenBox.height - 20)),
      );
      await page.waitForTimeout(500);
    }
    await page.keyboard.press(copyShortcut);
    await expect.poll(clipboardText).toBe(selectAllSnapshot);

    const mouseInputCount = gateway.state.terminalInputs.length;
    await page.mouse.click(screenBox.x + 30, screenBox.y + 30);
    await page.mouse.move(screenBox.x + 80, screenBox.y + 60, { steps: 3 });
    await expect.poll(() => gateway.state.terminalInputs.length).toBeGreaterThan(mouseInputCount);
    expect(gateway.state.terminalInputs.slice(mouseInputCount).some((data) => data.includes("\u001b[<"))).toBe(true);
    gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");

    await openSession("matrix-review");
    const reviewLine = "REVIEW-ONLY terminal selection";
    gateway.sendTerminalOutput(`\r\n${reviewLine}\r\n`, "matrix-review");
    await terminalSurface().getByText(reviewLine, { exact: false }).waitFor({ timeout: 10_000 });
    await selectBetween(reviewLine, 0, reviewLine, reviewLine.length);
    await page.keyboard.press(copyShortcut);
    await expect.poll(clipboardText).toBe(reviewLine);
    expect(await clipboardText()).not.toContain("CLIP-FIRST");

    const reviewPaste = "review-pane-paste";
    const reviewInputCount = gateway.state.terminalInputs.length;
    await writeClipboard(reviewPaste);
    await page.keyboard.press(pasteShortcut);
    await expect.poll(() => gateway.state.terminalInputs.slice(reviewInputCount)).toEqual([reviewPaste]);
    expect(gateway.state.terminalInputEvents.at(-1)).toEqual({
      session: "matrix-review",
      data: reviewPaste,
    });
  }, 120_000);
});
