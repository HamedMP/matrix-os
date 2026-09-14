import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

interface TerminalSizingState {
  declarations: Array<{ source: "attach" | "resize"; cols: number; rows: number }>;
  confirmations: Array<{ cols: number; rows: number }>;
}

const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";
const TERMINAL_REF = { workspaceId: WORKSPACE_ID, tabId: TAB_ID };

async function installTerminalGateway(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: TerminalSizingState = { declarations: [], confirmations: [] };
    (window as typeof window & { __terminalSizing?: TerminalSizingState }).__terminalSizing = state;
    window.localStorage.setItem("matrix-os-terminal-settings", JSON.stringify({
      state: { themeId: "light", fontSize: 13 },
      version: 0,
    }));

    class TerminalWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = TerminalWebSocket.CONNECTING;
      bufferedAmount = 0;
      binaryType: BinaryType = "blob";
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        const parsed = new URL(this.url);
        const cols = Number(parsed.searchParams.get("cols"));
        const rows = Number(parsed.searchParams.get("rows"));
        if (parsed.searchParams.get("client") === "hard" && cols > 0 && rows > 0) {
          state.declarations.push({ source: "attach", cols, rows });
        }
        window.setTimeout(() => {
          this.readyState = TerminalWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          const canonical = cols > 0 && rows > 0 ? { cols, rows } : { cols: 120, rows: 40 };
          state.confirmations.push(canonical);
          this.receive({
            type: "attached",
            terminalRef: TERMINAL_REF,
            canonicalSize: canonical,
            revision: 1,
            nextSeq: 0,
          });
          this.receive({ type: "replay-start", terminalRef: TERMINAL_REF, revision: 1, fromSeq: 0 });
          this.receive({ type: "output", terminalRef: TERMINAL_REF, revision: 1, seq: 0, data: "matrix@web:~$ real rows fill this pane" });
          this.receive({ type: "replay-end", terminalRef: TERMINAL_REF, revision: 1, nextSeq: 1, toSeq: 0 });
        }, 0);
      }

      send(raw: string): void {
        const frame = JSON.parse(raw) as { type?: string; size?: { cols?: number; rows?: number } };
        if (frame.type === "resize" && frame.size?.cols && frame.size.rows) {
          const canonical = { cols: frame.size.cols, rows: frame.size.rows };
          state.declarations.push({ source: "resize", ...canonical });
          state.confirmations.push(canonical);
          window.setTimeout(() => this.receive({
            type: "canonical-size",
            terminalRef: TERMINAL_REF,
            revision: 2,
            canonicalSize: canonical,
          }), 0);
        } else if (frame.type === "ping") {
          window.setTimeout(() => this.receive({ type: "pong", terminalRef: TERMINAL_REF, revision: 2 }), 0);
        }
      }

      close(): void {
        this.readyState = TerminalWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }

      private receive(frame: unknown): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: TerminalWebSocket,
    });
  });
}

async function mockShellApis(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-matrix-platform-session": "platform" });
  await page.route("**/api/settings/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname.endsWith("/onboarding-status")
      ? { complete: true }
      : {
          background: { type: "pattern" },
          dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
          pinnedApps: [],
          hasKey: true,
        };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/identity", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ handle: "test", displayName: "Test User" }),
  }));
  await page.route("**/api/apps**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/shell/bootstrap", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ layout: { windows: [] }, apps: [], modules: [], icons: {} }),
  }));
  await page.route("**/api/terminal/preferences", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ preferences: { shellThemeId: "light" } }),
  }));
  await page.route("**/api/auth/ws-token", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ token: "terminal-e2e-token", expiresAt: Date.now() + 300_000 }),
  }));
  await page.route("**/api/terminal/workspaces", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ workspaces: [{
      id: WORKSPACE_ID,
      scope: "main",
      internalName: "zw_00000000000000000000000000000001",
      canonicalSize: { cols: 120, rows: 40 },
      status: "running",
      revision: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      tabs: [{ id: TAB_ID, internalName: "mt_00000000000000000000000000000001", name: "Main", cwd: "projects", status: "running", revision: 1, createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" }],
    }] }),
  }));
  await page.route("**/api/terminal/layout", (route) => {
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tabs: [{
          id: "tab-main",
          label: "Main",
          paneTree: { type: "pane", id: "pane-main", cwd: "projects", sessionId: `${WORKSPACE_ID}:${TAB_ID}` },
        }],
        activeTabId: "tab-main",
        sidebarOpen: false,
      }),
    });
  });
  await page.route("**/api/layout", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{\"ok\":true}",
  }));
}

test("a tall light desktop terminal grows real rows without a black gap", async ({ page }) => {
  await installTerminalGateway(page);
  await mockShellApis(page);
  await page.setViewportSize({ width: 1_440, height: 1_200 });
  await page.goto("/");
  await page.waitForSelector("[data-testid='dock-settings']", { timeout: 15_000 });

  const canvasMode = page.getByRole("button", { name: "Canvas mode" });
  if ((await canvasMode.getAttribute("aria-pressed")) !== "true") {
    await canvasMode.click();
  }
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Terminal");
  await page.keyboard.press("Enter");

  const terminalHost = page.locator(".ph-no-capture").filter({ has: page.locator(".xterm-screen") }).first();
  await expect(terminalHost.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
  await expect(terminalHost.locator(".xterm")).toHaveCSS("visibility", "visible");
  await expect.poll(async () => page.evaluate(() => (
    (window as typeof window & { __terminalSizing?: TerminalSizingState }).__terminalSizing?.confirmations.length ?? 0
  ))).toBeGreaterThan(0);

  const initial = await page.evaluate(() => {
    const state = (window as typeof window & { __terminalSizing?: TerminalSizingState }).__terminalSizing;
    return state?.confirmations.at(-1) ?? null;
  });
  expect(initial).not.toBeNull();

  const resizeHandle = page.locator(".cursor-se-resize:visible").last();
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 320, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & { __terminalSizing?: TerminalSizingState }).__terminalSizing;
    return state?.declarations.at(-1)?.rows ?? 0;
  })).toBeGreaterThan(initial!.rows);

  const result = await page.evaluate(() => {
    const state = (window as typeof window & { __terminalSizing?: TerminalSizingState }).__terminalSizing!;
    const host = document.querySelector<HTMLElement>(".ph-no-capture:has(.xterm-screen)")!;
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const root = host.querySelector<HTMLElement>(".xterm")!;
    const viewport = host.querySelector<HTMLElement>(".xterm-viewport")!;
    const scrollable = host.querySelector<HTMLElement>(".xterm-scrollable-element")!;
    const confirmed = state.confirmations.at(-1)!;
    const hostRect = host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    return {
      declared: state.declarations.at(-1)!,
      confirmed,
      gap: hostRect.bottom - screenRect.bottom,
      cellHeight: screenRect.height / confirmed.rows,
      colors: [host, root, viewport, scrollable].map((element) => getComputedStyle(element).backgroundColor),
      screenBottomWithinHost: screenRect.bottom - hostRect.top,
    };
  });

  expect(result.declared.rows).toBe(result.confirmed.rows);
  expect(result.gap).toBeGreaterThanOrEqual(-0.5);
  expect(result.gap).toBeLessThan(result.cellHeight);
  expect(new Set(result.colors)).toEqual(new Set(["rgb(251, 241, 199)"]));
  await page.addStyleTag({
    content: "[data-sonner-toaster], [data-sonner-toast] { display: none !important; }",
  });

  const screenshot = await terminalHost.screenshot();
  const image = sharp(screenshot);
  const metadata = await image.metadata();
  const raw = await image.removeAlpha().raw().toBuffer();
  const width = metadata.width!;
  const height = metadata.height!;
  const firstGapRow = Math.max(0, Math.ceil(result.screenBottomWithinHost));
  for (let y = firstGapRow; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      expect(raw[offset]! + raw[offset + 1]! + raw[offset + 2]!).toBeGreaterThan(24);
    }
  }

  const terminalApp = terminalHost.locator("xpath=ancestor::*[@role='application' and @aria-label='Terminal'][1]");
  await expect(terminalApp).toHaveScreenshot("light-terminal-tall.png", {
    maxDiffPixelRatio: 0.005,
  });
});
