import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    .getByTestId("desktop-terminal-app")
    .locator('[data-retained-pane][data-active="true"] [data-terminal-surface]');

  async function clipboardText(): Promise<string> {
    return app.evaluate(({ clipboard }) => clipboard.readText());
  }

  async function writeClipboard(text: string): Promise<void> {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  }

  async function terminalPoint(
    text: string,
    characterIndex: number,
    cellOffset = 0.5,
  ): Promise<CellPoint> {
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
      x: screenBox.x + (start + characterIndex + cellOffset) * cellWidth,
      y: rowBox.y + rowBox.height / 2,
    };
  }

  async function selectBetween(
    startText: string,
    startIndex: number,
    endText: string,
    endIndexExclusive: number,
  ): Promise<void> {
    // xterm shifts selection coordinates by half a cell before rounding. A
    // synthetic pointer exactly at the midpoint can therefore land on either
    // side when Chromium and xterm use slightly different fractional widths.
    // Keep both anchors safely inside the intended selection halves.
    const start = await terminalPoint(startText, startIndex, 0.25);
    const end = await terminalPoint(endText, Math.max(0, endIndexExclusive - 1), 0.75);
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
    // Intentional stability soak (not output-readiness sync): with mouse
    // reporting enabled, roam the pointer to prove stray motion reports do
    // not disturb the Select All snapshot. Keep the fixed dwell so each of
    // the 20 positions gets time to emit before the re-copy assertion.
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
    .getByTestId("desktop-terminal-app")
    .locator('[data-retained-pane][data-active="true"] [data-terminal-surface]');

  async function clipboardText(): Promise<string> {
    return app.evaluate(({ clipboard }) => clipboard.readText());
  }

  async function writeClipboard(text: string): Promise<void> {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  }

  interface TerminalDiagnostics {
    cols: number;
    rows: number;
    viewportY: number;
    baseY: number;
    cursorY: number;
    cursorX: number;
    bufferLength: number;
    mouseTrackingMode: string;
    selection: string;
    hasActiveLink: boolean;
    activeElement?: {
      tagName: string;
      className: string;
      id: string;
    } | null;
    hitTarget?: {
      tagName: string;
      className: string;
      id: string;
      isTerminalSurface: boolean;
    } | null;
  }

  async function readTerminalDiagnostics(
    point?: { x: number; y: number },
  ): Promise<TerminalDiagnostics> {
    return page.evaluate(({ pt }) => {
      const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
      const diagFn = (host as any)?.__terminalDiagnostics;
      const baseDiag = typeof diagFn === "function" ? diagFn() : {};
      const hit = pt ? document.elementFromPoint(pt.x, pt.y) : null;
      const active = document.activeElement;
      return {
        cols: baseDiag.cols ?? 0,
        rows: baseDiag.rows ?? 0,
        viewportY: baseDiag.viewportY ?? -1,
        baseY: baseDiag.baseY ?? -1,
        cursorY: baseDiag.cursorY ?? -1,
        cursorX: baseDiag.cursorX ?? -1,
        bufferLength: baseDiag.bufferLength ?? 0,
        mouseTrackingMode: baseDiag.mouseTrackingMode ?? "unknown",
        selection: baseDiag.selection ?? "",
        hasActiveLink: Boolean(baseDiag.hasActiveLink),
        activeElement: active ? {
          tagName: active.tagName,
          className: active.className,
          id: active.id,
        } : null,
        hitTarget: hit ? {
          tagName: hit.tagName,
          className: hit.className,
          id: hit.id,
          isTerminalSurface: Boolean(hit.closest("[data-terminal-surface]")),
        } : null,
      };
    }, { pt: point });
  }

  async function waitForTerminalOutput(
    marker: string,
    options?: { timeout?: number },
  ): Promise<void> {
    await expect.poll(async () => {
      return page.evaluate((text) => {
        const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
        const term = (host as any)?.__xtermTerminal;
        if (!term?.buffer?.active) return false;
        const buffer = term.buffer.active;
        const totalLines = buffer.length;
        const start = Math.max(0, totalLines - 250);
        for (let i = totalLines - 1; i >= start; i--) {
          const line = buffer.getLine(i)?.translateToString(true) ?? "";
          if (line.includes(text)) return true;
        }
        return false;
      }, marker);
    }, {
      timeout: options?.timeout ?? 15_000,
      message: `Terminal output marker "${marker}" did not appear in buffer within timeout`,
    }).toBe(true);
  }

  async function waitForRenderFrames(count = 2): Promise<void> {
    await page.evaluate(async (frames) => {
      for (let i = 0; i < frames; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, count);
  }

  async function waitForMouseTrackingMode(
    expected: "none" | "!none",
    options?: { timeout?: number },
  ): Promise<void> {
    await expect.poll(async () => {
      const diag = await readTerminalDiagnostics();
      return expected === "none"
        ? diag.mouseTrackingMode === "none"
        : diag.mouseTrackingMode !== "none";
    }, {
      timeout: options?.timeout ?? 10_000,
      message: `Terminal mouseTrackingMode did not settle to "${expected}"`,
    }).toBe(true);
  }

  async function readTerminalSelection(): Promise<string> {
    return page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
      const reader = (host as any)?.__readTerminalSelection;
      if (typeof reader === "function") return reader();
      const term = (host as any)?.__xtermTerminal;
      return term?.getSelection?.() ?? "";
    });
  }

  async function clearTerminalSelectionForTest(): Promise<void> {
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
      // Prefer the renderer hook: it clears xterm selection plus the
      // confirmed* fallback refs that readTerminalSelection() consults when
      // xterm/DOM selection are empty. Fall back to direct clears for older
      // builds without the hook.
      const clearer = (host as any)?.__clearTerminalSelection;
      if (typeof clearer === "function") {
        clearer();
        return;
      }
      const term = (host as any)?.__xtermTerminal;
      term?.clearSelection?.();
      window.getSelection()?.removeAllRanges();
    });
  }

  async function scrollTerminalToBottom(): Promise<void> {
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
      (host as any)?.__xtermTerminal?.scrollToBottom?.();
    });
    await waitForRenderFrames(1);
  }

  async function waitForMarkerAtVisibleRow(
    marker: string,
    expectedVisibleRow: number,
    options?: { timeout?: number },
  ): Promise<void> {
    // terminalGrid().point(col,row) maps visible rows, but
    // waitForTerminalOutput() scans the last 250 buffer lines. Without this
    // check a surviving scrollback could leave point(0,0) aimed at stale
    // content while the marker wait still passes.
    await expect.poll(async () => {
      return page.evaluate(({ text }) => {
        const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
        const term = (host as any)?.__xtermTerminal;
        if (!term?.buffer?.active) return -999;
        const buffer = term.buffer.active;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const line = buffer.getLine(i)?.translateToString(true) ?? "";
          if (line.includes(text)) return i - buffer.viewportY;
        }
        return -998;
      }, { text: marker });
    }, {
      timeout: options?.timeout ?? 10_000,
      message: `Marker "${marker}" did not settle at visible row ${expectedVisibleRow}`,
    }).toBe(expectedVisibleRow);
  }

  async function expectTerminalPoint(
    point: CellPoint,
    label: string,
  ): Promise<CellPoint> {
    const diag = await readTerminalDiagnostics(point);
    if (!diag.hitTarget || !diag.hitTarget.isTerminalSurface) {
      const screenshotPath = join(EVIDENCE_DIR, `target-miss-${label}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => null);
      throw new Error(
        `Intended pointer target "${label}" at (${point.x}, ${point.y}) is outside terminal surface or obstructed: ${JSON.stringify(diag.hitTarget)}. Diagnostics: ${JSON.stringify(diag)}`,
      );
    }
    return point;
  }

  async function dismissOpenContextMenu(): Promise<void> {
    const menu = page.getByRole("menu", { name: "Terminal actions" });
    if (await menu.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => null);
    }
  }

  async function terminalGrid() {
    await expect.poll(
      () => gateway.state.terminalResizeEvents.findLast(
        (event) => event.session === "matrix-task-1",
      ),
      { timeout: 10_000 },
    ).toBeTruthy();
    const [screenBox, resize, liveDimensions] = await Promise.all([
      terminalSurface().locator(".xterm-screen").boundingBox(),
      Promise.resolve(gateway.state.terminalResizeEvents.findLast(
        (event) => event.session === "matrix-task-1",
      )),
      page.evaluate(() => {
        const host = document.querySelector<HTMLElement>("[data-terminal-viewport]");
        const term = (host as any)?.__xtermTerminal;
        return term ? { cols: term.cols, rows: term.rows } : null;
      }),
    ]);
    if (!screenBox || !resize) throw new Error("production terminal geometry is unavailable");
    const cols = liveDimensions?.cols ?? resize.cols;
    const rows = liveDimensions?.rows ?? resize.rows;
    return {
      screenBox,
      resize: { cols, rows },
      point: (column: number, row: number) => ({
        x: screenBox.x + (column + 0.5) * (screenBox.width / cols),
        y: screenBox.y + (row + 0.5) * (screenBox.height / rows),
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

  beforeEach(async () => {
    await dismissOpenContextMenu();
    const diag = await readTerminalDiagnostics();
    if (diag.mouseTrackingMode !== "none") {
      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
      await waitForMouseTrackingMode("none");
    }
    await clearTerminalSelectionForTest();
    await scrollTerminalToBottom();
    // Guard test isolation: the renderer keeps confirmed* fallbacks after a
    // programmatic clear, so poll until the observable selection is empty.
    await expect.poll(readTerminalSelection, {
      timeout: 5_000,
      message: "Terminal selection did not reset between cases",
    }).toBe("");
    await writeClipboard(`sentinel-${Math.random().toString(36).slice(2)}`);
  });

  it("copies a real mouse selection when webdriver accessibility rendering is disabled", async () => {
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
    const firstLine = "PRODUCTION-FIRST alpha beta";
    const secondLine = "PRODUCTION-SECOND gamma delta";
    const expected = `${firstLine}\n${secondLine}`;
    gateway.sendTerminalOutput(`\u001bc${firstLine}\r\n${secondLine}`);
    await waitForTerminalOutput(secondLine);
    await scrollTerminalToBottom();
    await waitForMarkerAtVisibleRow(firstLine, 0);
    await waitForMarkerAtVisibleRow(secondLine, 1);
    await waitForRenderFrames(2);
    const { point } = await terminalGrid();

    const start = await expectTerminalPoint(point(0, 0), "prod-sel-start");
    const end = await expectTerminalPoint(point(secondLine.length, 1), "prod-sel-end");

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(readTerminalSelection).toContain(firstLine);
    await writeClipboard("stale clipboard value");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(clipboardText).toBe(expected);

    const insideSelection = await expectTerminalPoint(point(4, 0), "context-menu-inside-selection");
    await page.mouse.click(insideSelection.x, insideSelection.y, { button: "right" });
    const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
    await copy.waitFor({ timeout: 10_000 });
    expect(await copy.isEnabled()).toBe(true);
    await dismissOpenContextMenu();
  }, 60_000);

  it("creates a copyable drag selection while TUI mouse reporting remains enabled", async () => {
    const line = "MOUSE-MODE-SELECTION alpha beta gamma";
    gateway.sendTerminalOutput(`\u001bc${line}\u001b[?1003h\u001b[?1006h`);
    await waitForTerminalOutput(line);
    await waitForMouseTrackingMode("!none");
    await scrollTerminalToBottom();
    await waitForMarkerAtVisibleRow(line, 0);
    await waitForRenderFrames(2);
    const { point } = await terminalGrid();
    const start = await expectTerminalPoint(point(0, 0), "mouse-mode-drag-start");
    const end = await expectTerminalPoint(point(line.length, 0), "mouse-mode-drag-end");

    try {
      const beforeProbeClick = gateway.state.terminalInputs.length;
      const probePoint = await expectTerminalPoint(point(2, 0), "mouse-mode-probe-click");
      await page.mouse.click(probePoint.x, probePoint.y);
      await expect.poll(() => gateway.state.terminalInputs.length).toBeGreaterThan(beforeProbeClick);
      expect(gateway.state.terminalInputs.slice(beforeProbeClick).some((data) => data.includes("\u001b[<")))
        .toBe(true);

      await page.mouse.move(start.x, start.y);
      await waitForRenderFrames(1);
      const beforeDrag = gateway.state.terminalInputs.length;
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      await waitForRenderFrames(1);
      expect(gateway.state.terminalInputs.slice(beforeDrag)).toEqual([]);

      await expect.poll(readTerminalSelection).toBe(line);
      await writeClipboard("stale clipboard value");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      await expect.poll(clipboardText).toBe(line);

      const insideSelection = await expectTerminalPoint(point(4, 0), "mouse-mode-context-menu");
      await page.mouse.click(insideSelection.x, insideSelection.y, { button: "right" });
      const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
      await copy.waitFor({ timeout: 10_000 });
      expect(await copy.isEnabled()).toBe(true);
      await copy.click();
      await expect.poll(clipboardText).toBe(line);

      const beforeClick = gateway.state.terminalInputs.length;
      const resumeClick = await expectTerminalPoint(point(2, 0), "mouse-mode-resume-click");
      await page.mouse.click(resumeClick.x, resumeClick.y);
      await expect.poll(() => gateway.state.terminalInputs.length).toBeGreaterThan(beforeClick);
      expect(gateway.state.terminalInputs.slice(beforeClick).some((data) => data.includes("\u001b[<")))
        .toBe(true);

      const prefix = "MOUSE-DOUBLECLICK prefix ";
      const word = "targetword";
      gateway.sendTerminalOutput(
        `\u001bc${prefix}${word} suffix\u001b[?1003h\u001b[?1006h`,
      );
      await waitForTerminalOutput(word);
      await waitForMouseTrackingMode("!none");
      await scrollTerminalToBottom();
      await waitForMarkerAtVisibleRow(word, 0);
      await waitForRenderFrames(2);
      const wordPoint = await expectTerminalPoint(point(prefix.length + 3, 0), "mouse-mode-dblclick");
      await page.mouse.dblclick(wordPoint.x, wordPoint.y);
      await expect.poll(readTerminalSelection).toBe(word);
      await writeClipboard("stale clipboard value");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      await expect.poll(clipboardText).toBe(word);
    } finally {
      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
      await waitForMouseTrackingMode("none");
      await dismissOpenContextMenu();
    }
  }, 60_000);

  it("selects the complete xterm scrollback rather than only the visible viewport", async () => {
    const { resize, point } = await terminalGrid();
    const lines = Array.from(
      { length: resize.rows + 12 },
      (_, index) => `SCROLLBACK-${String(index).padStart(3, "0")}`,
    );
    gateway.sendTerminalOutput(`\u001bc${lines.join("\r\n")}`);
    await waitForTerminalOutput(lines.at(-1)!);
    await waitForTerminalOutput(lines.at(0)!);
    await scrollTerminalToBottom();
    await waitForRenderFrames(2);

    const menuPoint = await expectTerminalPoint(point(2, resize.rows - 2), "scrollback-select-all-click");
    await page.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });

    const menu = page.getByRole("menu", { name: "Terminal actions" });
    const selectAllItem = page.getByRole("menuitem", { name: "Select All", exact: true });
    try {
      await menu.waitFor({ state: "visible", timeout: 10_000 });
      await selectAllItem.waitFor({ state: "visible", timeout: 10_000 });
    } catch (err: unknown) {
      const diag = await readTerminalDiagnostics(menuPoint);
      const screenshotPath = join(EVIDENCE_DIR, `select-all-menu-miss-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => null);
      throw new Error(
        `Terminal actions menu or "Select All" failed to open on right-click at (${menuPoint.x}, ${menuPoint.y}). `
        + `Diagnostics: ${JSON.stringify(diag)}. Evidence: ${screenshotPath}`,
        { cause: err },
      );
    }

    await selectAllItem.click();
    await expect.poll(readTerminalSelection, {
      timeout: 10_000,
      message: "Select All did not populate terminal selection",
    }).toContain(lines.at(0)!);
    expect(await readTerminalSelection()).toContain(lines.at(-1)!);

    await writeClipboard("sentinel-before-scrollback-copy");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(clipboardText).toContain(lines.at(0)!);
    const copied = await clipboardText();
    expect(copied).toContain(lines.at(-1)!);
  }, 60_000);

  it("selects and copies a word immediately on double click without pointer movement", async () => {
    const prefix = "DOUBLECLICK prefix ";
    const word = "targetword";
    gateway.sendTerminalOutput(`\u001bc${prefix}${word} suffix`);
    await waitForTerminalOutput(word);
    await scrollTerminalToBottom();
    await waitForMarkerAtVisibleRow(word, 0);
    await waitForRenderFrames(2);
    const { point } = await terminalGrid();
    const wordPoint = await expectTerminalPoint(point(prefix.length + 3, 0), "dblclick-targetword");
    await page.mouse.dblclick(wordPoint.x, wordPoint.y);
    await expect.poll(readTerminalSelection).toBe(word);
    await writeClipboard("stale clipboard value");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(clipboardText).toBe(word);
  }, 60_000);

  it("extends a drag selection by auto-scrolling beyond both terminal edges", async () => {
    const { resize, screenBox, point } = await terminalGrid();
    const lines = Array.from(
      { length: resize.rows + 80 },
      (_, index) => `EDGE-SCROLL-${String(index).padStart(3, "0")}`,
    );
    gateway.sendTerminalOutput(`\u001bc${lines.join("\r\n")}`);
    await waitForTerminalOutput(lines.at(-1)!);
    await waitForTerminalOutput(lines[0]!);
    await scrollTerminalToBottom();
    await waitForRenderFrames(2);

    await writeClipboard("sentinel-before-upward-drag");
    const upwardStart = await expectTerminalPoint(point(5, resize.rows - 2), "upward-edge-drag-start");
    await page.mouse.move(upwardStart.x, upwardStart.y);
    await page.mouse.down();
    await page.mouse.move(upwardStart.x, screenBox.y - 32, { steps: 8 });

    // Poll until auto-scroll extends selection upward past line 20
    try {
      await expect.poll(readTerminalSelection, {
        timeout: 10_000,
        message: `Upward auto-scroll did not extend selection to "${lines[20]}"`,
      }).toContain(lines[20]);
    } finally {
      await page.mouse.up();
    }

    // Assert selection exists before invoking copy so stale clipboard values cannot obscure failure
    const upwardSelection = await readTerminalSelection();
    expect(upwardSelection).toContain(lines[20]);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(clipboardText).toContain(lines[20]);

    // Reset selection and clipboard for downward test
    await writeClipboard("sentinel-before-downward-drag");
    const resetClick = await expectTerminalPoint(point(2, 2), "reset-drag-click");
    await page.mouse.click(resetClick.x, resetClick.y);
    await expect.poll(readTerminalSelection).toBe("");

    await page.mouse.move(screenBox.x + screenBox.width / 2, screenBox.y + screenBox.height / 2);
    await page.mouse.wheel(0, -100_000);
    // Wait until viewport scrolled to top
    await expect.poll(async () => (await readTerminalDiagnostics()).viewportY).toBe(0);
    await waitForRenderFrames(2);

    const downwardStart = await expectTerminalPoint(point(5, 1), "downward-edge-drag-start");
    await page.mouse.move(downwardStart.x, downwardStart.y);
    await page.mouse.down();
    await page.mouse.move(
      downwardStart.x,
      screenBox.y + screenBox.height + 32,
      { steps: 8 },
    );

    // Poll until auto-scroll extends selection downward past last line
    try {
      await expect.poll(readTerminalSelection, {
        timeout: 10_000,
        message: `Downward auto-scroll did not extend selection to "${lines.at(-1)}"`,
      }).toContain(lines.at(-1)!);
    } finally {
      await page.mouse.up();
    }

    const downwardSelection = await readTerminalSelection();
    expect(downwardSelection).toContain(lines.at(-1)!);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
    await expect.poll(clipboardText).toContain(lines.at(-1)!);
  }, 60_000);

  it("extends a mouse-reporting selection by auto-scrolling beyond both edges", async () => {
    const resizeCountBeforeReload = gateway.state.terminalResizeEvents.filter(
      (event) => event.session === "matrix-task-1",
    ).length;
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
    await expect.poll(
      () => gateway.state.terminalResizeEvents.filter(
        (event) => event.session === "matrix-task-1",
      ).length,
      { timeout: 10_000 },
    ).toBeGreaterThan(resizeCountBeforeReload);
    const { resize, screenBox, point } = await terminalGrid();
    const lines = Array.from(
      { length: resize.rows + 80 },
      (_, index) => `MOUSE-EDGE-SCROLL-${String(index).padStart(3, "0")}`,
    );
    gateway.sendTerminalOutput(`\u001bc${lines.join("\r\n")}`);
    await waitForTerminalOutput(lines.at(-1)!);
    await waitForTerminalOutput(lines[0]!);
    await scrollTerminalToBottom();
    await waitForRenderFrames(2);

    const probePoint = await expectTerminalPoint(point(2, resize.rows - 2), "mouse-edge-probe-point");
    await page.mouse.click(probePoint.x, probePoint.y);
    gateway.sendTerminalOutput("\u001b[?1003h\u001b[?1006h");
    await waitForMouseTrackingMode("!none");
    await waitForRenderFrames(1);

    try {
      const upwardInputCount = gateway.state.terminalInputs.length;
      const upwardStart = await expectTerminalPoint(point(5, resize.rows - 2), "mouse-upward-drag-start");
      await page.mouse.move(upwardStart.x, upwardStart.y);
      await page.mouse.down();
      await page.mouse.move(upwardStart.x, screenBox.y - 32, { steps: 8 });

      try {
        await expect.poll(readTerminalSelection, {
          timeout: 10_000,
          message: `Mouse-reporting upward auto-scroll did not reach "${lines[70]}"`,
        }).toContain(lines[70]);
      } finally {
        await page.mouse.up();
      }

      await writeClipboard("sentinel-before-mouse-upward-copy");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      await expect.poll(clipboardText).toContain(lines[70]);
      expect(gateway.state.terminalInputs.slice(upwardInputCount).some(
        (data) => data.includes("\u001b[<64;"),
      )).toBe(true);

      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
      await waitForMouseTrackingMode("none");
      await page.mouse.move(
        screenBox.x + screenBox.width / 2,
        screenBox.y + screenBox.height / 2,
      );
      await page.mouse.wheel(0, -100_000);
      await expect.poll(async () => (await readTerminalDiagnostics()).viewportY).toBe(0);
      await waitForRenderFrames(2);
      const clickTop = await expectTerminalPoint(point(2, 2), "mouse-edge-top-click");
      await page.mouse.click(clickTop.x, clickTop.y);
      gateway.sendTerminalOutput("\u001b[?1003h\u001b[?1006h");
      await waitForMouseTrackingMode("!none");
      await waitForRenderFrames(1);

      const downwardInputCount = gateway.state.terminalInputs.length;
      const downwardStart = await expectTerminalPoint(point(5, 1), "mouse-downward-drag-start");
      await page.mouse.move(downwardStart.x, downwardStart.y);
      await page.mouse.down();
      await page.mouse.move(
        downwardStart.x,
        screenBox.y + screenBox.height + 32,
        { steps: 8 },
      );

      try {
        await expect.poll(readTerminalSelection, {
          timeout: 10_000,
          message: `Mouse-reporting downward auto-scroll did not reach "${lines[82]}"`,
        }).toContain(lines[82]);
      } finally {
        await page.mouse.up();
      }

      await writeClipboard("sentinel-before-mouse-downward-copy");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+Shift+C");
      // The stub gateway does not redraw a TUI viewport in response to the wheel report,
      // so assert a stable full row immediately after the column-trimmed anchor here;
      // the binary report below proves the app-facing path.
      await expect.poll(clipboardText).toContain(lines[82]);
      expect(gateway.state.terminalInputs.slice(downwardInputCount).some(
        (data) => data.includes("\u001b[<65;"),
      )).toBe(true);
    } finally {
      gateway.sendTerminalOutput("\u001b[?1003l\u001b[?1006l");
      await waitForMouseTrackingMode("none");
      await dismissOpenContextMenu();
      await page.mouse.move(
        screenBox.x + screenBox.width / 2,
        screenBox.y + screenBox.height / 2,
      );
    }
  }, 60_000);
});
