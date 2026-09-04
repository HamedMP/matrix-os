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
    await expect.poll(
      () => gateway.state.terminalResizeEvents.some(
        (event) => event.session === activeSessionName,
      ),
      { timeout: 10_000, message: "terminal column count is unavailable" },
    ).toBe(true);
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
    const end = await terminalPoint(endText, Math.max(0, endIndexExclusive - 0.5));
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
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.operator?.invoke === "function");
    await page.evaluate(async () => {
      await window.operator.invoke("auth:start-device-flow", {});
    });
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
    await terminalSurface()
      .locator('.xterm-accessibility-tree [role="listitem"]', { hasText: secondLine })
      .last()
      .waitFor({ timeout: 10_000 });

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
      const terminalInput = terminalSurface().locator(".xterm-helper-textarea");
      await expect.poll(
        () => terminalInput.evaluate((element) => element === document.activeElement),
        { message: "terminal focus was not restored after Select All" },
      ).toBe(true);
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
    await terminalSurface()
      .locator('.xterm-accessibility-tree [role="listitem"]', { hasText: reviewLine })
      .last()
      .waitFor({ timeout: 10_000 });
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

suite("packaged Electron production-mode terminal selection", () => {
  let gateway: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  const terminalSurface = () => page
    .getByRole("heading", { name: "matrix-task-1", exact: true })
    .locator("xpath=ancestor::section[1]")
    .locator("[data-terminal-surface]");

  async function terminalGrid() {
    await expect.poll(
      () => gateway.state.terminalResizeEvents.findLast(
        (event) => event.session === "matrix-task-1",
      ),
      { timeout: 10_000 },
    ).toBeTruthy();
    const [screenBox, resize] = await Promise.all([
      terminalSurface().locator(".xterm-screen").boundingBox(),
      Promise.resolve(gateway.state.terminalResizeEvents.findLast(
        (event) => event.session === "matrix-task-1",
      )),
    ]);
    if (!screenBox || !resize) throw new Error("production terminal geometry is unavailable");
    return {
      screenBox,
      resize,
      point: (column: number, row: number) => ({
        x: screenBox.x + (column + 0.5) * (screenBox.width / resize.cols),
        y: screenBox.y + (row + 0.5) * (screenBox.height / resize.rows),
      }),
    };
  }

  beforeAll(async () => {
    gateway = await startStubGateway();
    userDataDir = mkdtempSync(join(tmpdir(), "matrix-terminal-production-selection-"));
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [DESKTOP_MAIN, "--disable-blink-features=AutomationControlled"],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: gateway.url,
        OPERATOR_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.operator?.invoke === "function");
    await page.evaluate(async () => {
      await window.operator.invoke("auth:start-device-flow", {});
    });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("heading", { name: "matrix-task-1", exact: true }).waitFor({ timeout: 10_000 });
    await terminalSurface().locator(".xterm-helper-textarea").focus();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  it("copies a real mouse selection when webdriver accessibility rendering is disabled", async () => {
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
    const firstLine = "PRODUCTION-FIRST alpha beta";
    const secondLine = "PRODUCTION-SECOND gamma delta";
    const expected = `${firstLine}\n${secondLine}`;
    gateway.sendTerminalOutput(`\u001bc${firstLine}\r\n${secondLine}`);
    await page.waitForTimeout(250);
    const { point } = await terminalGrid();

    const start = point(0, 0);
    const end = point(secondLine.length, 1);
    const hitTargets = await page.evaluate(({ startPoint, endPoint }) => {
      const describe = (pointValue: { x: number; y: number }) => {
        const target = document.elementFromPoint(pointValue.x, pointValue.y);
        return target instanceof HTMLElement
          ? { tag: target.tagName, className: target.className, terminalSurface: Boolean(target.closest("[data-terminal-surface]")) }
          : null;
      };
      return { start: describe(startPoint), end: describe(endPoint) };
    }, { startPoint: start, endPoint: end });
    expect(hitTargets).toEqual({
      start: expect.objectContaining({ terminalSurface: true }),
      end: expect.objectContaining({ terminalSurface: true }),
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();

    await app.evaluate(({ clipboard }) => clipboard.writeText("stale clipboard value"));
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected);

    const insideSelection = point(4, 0);
    await page.mouse.click(insideSelection.x, insideSelection.y, { button: "right" });
    const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
    await copy.waitFor();
    expect(await copy.isEnabled()).toBe(true);
  }, 60_000);

  it("creates a copyable drag selection while TUI mouse reporting remains enabled", async () => {
    const line = "MOUSE-MODE-SELECTION alpha beta gamma";
    gateway.sendTerminalOutput(`\u001bc${line}\u001b[?1003h\u001b[?1006h`);
    await page.waitForTimeout(250);
    const { point } = await terminalGrid();
    const start = point(0, 0);
    const end = point(line.length, 0);

    try {
      const beforeProbeClick = gateway.state.terminalInputs.length;
      await page.mouse.click(point(2, 0).x, point(2, 0).y);
      await expect.poll(() => gateway.state.terminalInputs.length).toBeGreaterThan(beforeProbeClick);
      expect(gateway.state.terminalInputs.slice(beforeProbeClick).some((data) => data.includes("\u001b[<")))
        .toBe(true);

      await page.mouse.move(start.x, start.y);
      await page.waitForTimeout(100);
      const beforeDrag = gateway.state.terminalInputs.length;
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(100);
      expect(gateway.state.terminalInputs.slice(beforeDrag)).toEqual([]);

      await app.evaluate(({ clipboard }) => clipboard.writeText("stale clipboard value"));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(line);

      const insideSelection = point(4, 0);
      await page.mouse.click(insideSelection.x, insideSelection.y, { button: "right" });
      const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
      await copy.waitFor();
      expect(await copy.isEnabled()).toBe(true);
      await copy.click();
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(line);

      const beforeClick = gateway.state.terminalInputs.length;
      await page.mouse.click(point(2, 0).x, point(2, 0).y);
      await expect.poll(() => gateway.state.terminalInputs.length).toBeGreaterThan(beforeClick);
      expect(gateway.state.terminalInputs.slice(beforeClick).some((data) => data.includes("\u001b[<")))
        .toBe(true);

      const prefix = "MOUSE-DOUBLECLICK prefix ";
      const word = "targetword";
      gateway.sendTerminalOutput(
        `\u001bc${prefix}${word} suffix\u001b[?1003h\u001b[?1006h`,
      );
      await page.waitForTimeout(250);
      const wordPoint = point(prefix.length + 3, 0);
      await page.mouse.dblclick(wordPoint.x, wordPoint.y);
      await app.evaluate(({ clipboard }) => clipboard.writeText("stale clipboard value"));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(word);
    } finally {
      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
    }
  }, 60_000);

  it("selects the complete xterm scrollback rather than only the visible viewport", async () => {
    const { resize, point } = await terminalGrid();
    const lines = Array.from(
      { length: resize.rows + 12 },
      (_, index) => `SCROLLBACK-${String(index).padStart(3, "0")}`,
    );
    gateway.sendTerminalOutput(`\u001bc${lines.join("\r\n")}`);
    await page.waitForTimeout(300);

    const menuPoint = point(2, resize.rows - 2);
    await page.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Select All", exact: true }).click();
    await page.waitForTimeout(50);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(
      () => app.evaluate(({ clipboard }) => clipboard.readText()),
    ).toContain(lines.at(0));
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain(lines.at(-1));
  }, 60_000);

  it("selects and copies a word immediately on double click without pointer movement", async () => {
    const prefix = "DOUBLECLICK prefix ";
    const word = "targetword";
    gateway.sendTerminalOutput(`\u001bc${prefix}${word} suffix`);
    await page.waitForTimeout(250);
    const { point } = await terminalGrid();
    const wordPoint = point(prefix.length + 3, 0);
    await page.mouse.dblclick(wordPoint.x, wordPoint.y);
    await app.evaluate(({ clipboard }) => clipboard.writeText("stale clipboard value"));
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(word);
  }, 60_000);

  it("extends a drag selection by auto-scrolling beyond both terminal edges", async () => {
    const { resize, screenBox, point } = await terminalGrid();
    const lines = Array.from(
      { length: resize.rows + 80 },
      (_, index) => `EDGE-SCROLL-${String(index).padStart(3, "0")}`,
    );
    gateway.sendTerminalOutput(`\u001bc${lines.join("\r\n")}`);
    await page.waitForTimeout(300);

    const upwardStart = point(5, resize.rows - 2);
    await page.mouse.move(upwardStart.x, upwardStart.y);
    await page.mouse.down();
    await page.mouse.move(upwardStart.x, screenBox.y - 32, { steps: 8 });
    await page.waitForTimeout(1_500);
    await page.mouse.up();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain(lines[20]);

    await page.mouse.click(point(2, 2).x, point(2, 2).y);
    await page.mouse.move(screenBox.x + screenBox.width / 2, screenBox.y + screenBox.height / 2);
    await page.mouse.wheel(0, -100_000);

    const downwardStart = point(5, 1);
    await page.mouse.move(downwardStart.x, downwardStart.y);
    await page.mouse.down();
    await page.mouse.move(
      downwardStart.x,
      screenBox.y + screenBox.height + 32,
      { steps: 8 },
    );
    await page.waitForTimeout(1_500);
    await page.mouse.up();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain(lines.at(-1));
  }, 60_000);

  it("extends a mouse-reporting selection by auto-scrolling beyond both edges", async () => {
    await page.reload();
    await page.waitForFunction(() => typeof window.operator?.invoke === "function");
    await page.evaluate(async () => {
      await window.operator.invoke("auth:start-device-flow", {});
    });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Terminal", exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Open matrix-task-1" }).click();
    await page.getByRole("heading", { name: "matrix-task-1", exact: true }).waitFor({ timeout: 10_000 });
    await terminalSurface().locator(".xterm-helper-textarea").focus();
    const { resize, screenBox, point } = await terminalGrid();
    const lines = Array.from(
      { length: resize.rows + 80 },
      (_, index) => `MOUSE-EDGE-SCROLL-${String(index).padStart(3, "0")}`,
    );
    gateway.sendTerminalOutput(`\u001bc${lines.join("\r\n")}`);
    await page.waitForTimeout(300);

    await page.mouse.click(point(2, resize.rows - 2).x, point(2, resize.rows - 2).y);
    gateway.sendTerminalOutput("\u001b[?1003h\u001b[?1006h");
    await page.waitForTimeout(100);

    try {
      const upwardInputCount = gateway.state.terminalInputs.length;
      const upwardStart = point(5, resize.rows - 2);
      await page.mouse.move(upwardStart.x, upwardStart.y);
      await page.mouse.down();
      await page.mouse.move(upwardStart.x, screenBox.y - 32, { steps: 8 });
      await page.waitForTimeout(1_500);
      await page.mouse.up();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain(lines[70]);
      expect(gateway.state.terminalInputs.slice(upwardInputCount).some(
        (data) => data.includes("\u001b[<64;"),
      )).toBe(true);

      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
      await page.mouse.move(
        screenBox.x + screenBox.width / 2,
        screenBox.y + screenBox.height / 2,
      );
      await page.mouse.wheel(0, -100_000);
      await page.mouse.click(point(2, 2).x, point(2, 2).y);
      gateway.sendTerminalOutput("\u001b[?1003h\u001b[?1006h");
      await page.waitForTimeout(100);

      const downwardInputCount = gateway.state.terminalInputs.length;
      const downwardStart = point(5, 1);
      await page.mouse.move(downwardStart.x, downwardStart.y);
      await page.mouse.down();
      await page.mouse.move(
        downwardStart.x,
        screenBox.y + screenBox.height + 32,
        { steps: 8 },
      );
      await page.waitForTimeout(1_500);
      await page.mouse.up();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      // The stub gateway does not redraw a TUI viewport in response to the wheel report,
      // so assert a stable full row immediately after the column-trimmed anchor here;
      // the binary report below proves the app-facing path.
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain(lines[82]);
      expect(gateway.state.terminalInputs.slice(downwardInputCount).some(
        (data) => data.includes("\u001b[<65;"),
      )).toBe(true);
    } finally {
      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
      await page.mouse.move(
        screenBox.x + screenBox.width / 2,
        screenBox.y + screenBox.height / 2,
      );
    }
  }, 60_000);
});
