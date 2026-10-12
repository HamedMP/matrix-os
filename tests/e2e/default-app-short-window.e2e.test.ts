import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "@tailwindcss/node";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import NotesWorkspace from "../../desktop/src/renderer/src/features/notes/NotesWorkspace";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});
const fixture = vi.hoisted(() => ({ notesError: "" }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({
  useConnection: (select: (state: unknown) => unknown) => select({ api: { forRuntime: () => ({}) }, runtimeSlot: "test", authGeneration: 1 }),
}));
vi.mock("../../desktop/src/renderer/src/features/desktop-shell/OSWindow", () => ({
  OSWindowSafeView: ({ children, area: _area, ...props }: React.ComponentProps<"div"> & { area: string }) => React.createElement("div", props, children),
}));
vi.mock("../../desktop/src/renderer/src/features/notes/NoteEditor", () => ({ default: () => null }));
vi.mock("../../desktop/src/renderer/src/features/notes/notes-controller", () => ({
  NotesController: class {
    subscribe = () => () => {};
    getSnapshot = () => ({ notes: [], selectedId: null, loading: false, creating: false, error: fixture.notesError, dirtyIds: [] });
  },
  registerActiveNotesController: () => () => {},
}));

const root = resolve(__dirname, "../..");
const { chromium } = createRequire(resolve(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
// Inline local imports in their real order; no preview server or external requests.
function stylesheet(file: string): string {
  const path = resolve(root, file);
  return readFileSync(path, "utf8").replace(/@import\s+["']([^"']+)["'];/g, (_, imported: string) => stylesheet(resolve(dirname(path), imported)));
}
const shared = (file: string) => stylesheet(`home/apps/_shared/${file}`);
const utilityCss = (app: string) => stylesheet(`home/apps/${app}/src/styles.css`) + stylesheet(`home/apps/${app}/src/design-refresh.css`) + shared("gallery-family.css") + shared("app-identities.css") + shared("matrix-brand.css");
async function show(page: Page, width: number, height: number, app: string, css: string, html: string) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html data-app="${app}"><head><style>${css}</style></head><body>${html}</body></html>`);
}
async function reveal(page: Page, container: string, target: string) {
  const scroll = page.locator(container);
  await page.locator(target).scrollIntoViewIfNeeded();
  const bounds = await scroll.boundingBox();
  const item = await page.locator(target).boundingBox();
  expect(bounds).not.toBeNull();
  expect(item).not.toBeNull();
  expect(item!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
  expect(item!.y + item!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
  expect(item!.y + item!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
}
describe("default app controls in short windows", () => {
  let browser: Browser;
  let notesCss: string;
  beforeAll(async () => {
    const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
    const notesSource = readFileSync(resolve(root, "desktop/src/renderer/src/features/notes/NotesWorkspace.tsx"), "utf8");
    notesCss = tailwind.build([...notesSource.matchAll(/className="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/))) + stylesheet("desktop/src/renderer/src/features/notes/notes.css");
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });

  it("keeps records and all expanded workspace controls reachable at 320 x 200", async () => {
    const page = await browser.newPage();
    try {
      const css = stylesheet("home/app-templates/connected-starter/src/style.css") + stylesheet("home/app-templates/connected-starter/src/styles/brand-tokens.css") + stylesheet("home/app-templates/connected-starter/src/styles/gallery-light.css");
      await show(page, 320, 200, "subscriptions", css, `<div class="workbench" data-app="subscriptions"><aside class="sidebar"><div class="brand"><strong>Subscriptions</strong></div><details class="workspace-controls" open><summary>Workspace</summary><div class="sidebar-filters"><label>Search<input></label><label>Status<select><option>All</option></select></label></div><div class="connection-card"><button id="connect">Connect email</button></div></details></aside><div class="main-column"><header class="topbar"><div><button>Import</button><button>Add subscription</button></div></header><main><h1>All subscriptions</h1><div style="height:300px"></div><button id="record">Edit subscription</button></main></div></div>`);
      expect(await page.locator("main").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(84);
      await reveal(page, ".sidebar", "#connect");
      await reveal(page, "main", "#record");
    } finally { await page.close(); }
  });

  it("gives Revenue descriptions the muted foreground on the current card", async () => {
    const page = await browser.newPage();
    try {
      await show(page, 640, 400, "revenue", stylesheet("home/app-templates/connected-starter/src/style.css") + stylesheet("home/app-templates/connected-starter/src/styles/brand-tokens.css") + stylesheet("home/app-templates/connected-starter/src/styles/gallery-light.css"), '<div class="workbench" data-app="revenue"><div class="revenue-overview"><div class="balance"><p>Description</p></div><span class="muted">Reference</span></div></div>');
      expect(await page.locator(".balance p").evaluate(element => getComputedStyle(element).color)).toBe(await page.locator(".muted").evaluate(element => getComputedStyle(element).color));
    } finally { await page.close(); }
  });

  it("scrolls to the last Weather search result at 360 x 450", async () => {
    const page = await browser.newPage();
    try {
      await show(page, 360, 450, "weather", utilityCss("weather"), `<div class="search-overlay"><div class="search-panel"><div class="search-bar"><input placeholder="Search"><button class="search-close">Close</button></div><div class="search-results">${Array.from({ length: 12 }, (_, index) => `<button class="search-result" id="city-${index}">City ${index}</button>`).join("")}</div></div></div>`);
      await reveal(page, ".search-results", "#city-11");
      const panel = await page.locator(".search-panel").boundingBox();
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(450);
      const lastCity = await page.locator("#city-11").boundingBox();
      expect(lastCity!.y + lastCity!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
      expect(await page.locator(".search-panel").evaluate(element => element.scrollTop)).toBe(0);
      expect((await page.locator(".search-close").boundingBox())!.y).toBeGreaterThanOrEqual(0);
    } finally { await page.close(); }
  });

  it("uses Clock's accent foreground for selected repeat days", async () => {
    const page = await browser.newPage();
    try {
      await show(page, 400, 400, "clock", utilityCss("clock"), '<button class="day day--on">Mon</button><button class="primary-btn">Reference</button>');
      expect(await page.locator(".day--on").evaluate(element => getComputedStyle(element).color)).toBe(await page.locator(".primary-btn").evaluate(element => getComputedStyle(element).color));
    } finally { await page.close(); }
  });

  it("keeps the Minesweeper board and Custom controls reachable at 640 x 320", async () => {
    const page = await browser.newPage();
    try {
      const css = stylesheet("home/apps/games/minesweeper/src/styles.css") + shared("game-refresh.css") + shared("matrix-brand.css");
      await show(page, 640, 320, "minesweeper", css, '<div class="ms-root"><div class="ms-frame"><header class="ms-header"><h1 class="ms-title">Minesweeper</h1><div class="ms-difficulty"><button class="ms-diff-btn">Beginner</button><button class="ms-diff-btn">Custom</button></div></header><div class="ms-custom"><label>Rows<input value="9"></label><label>Columns<input value="9"></label><label>Mines<input value="10"></label></div><div class="ms-panel"><div class="ms-readout">010</div><button class="ms-reset">Reset</button><div class="ms-readout">000</div></div><div class="ms-board-area"><div class="ms-grid" style="height:288px;width:288px"><button id="cell" class="ms-cell">1</button></div></div><footer class="ms-footer"><span class="ms-stat">Best time</span></footer></div></div>');
      expect(await page.locator(".ms-board-area").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(44);
      await page.locator("#cell").scrollIntoViewIfNeeded();
      const cell = await page.locator("#cell").boundingBox();
      expect(cell!.y).toBeGreaterThanOrEqual(0);
      expect(cell!.y + cell!.height).toBeLessThanOrEqual(320);
      await page.locator(".ms-custom input").first().scrollIntoViewIfNeeded();
      expect(await page.locator(".ms-custom input").first().isVisible()).toBe(true);
    } finally { await page.close(); }
  });

  it.each(["", "Your notes could not be loaded. Try again."])("keeps Electron Notes actions reachable at 600 x 400, error=%s", async error => {
    const page = await browser.newPage();
    try {
      fixture.notesError = error;
      const html = renderToStaticMarkup(React.createElement(NotesWorkspace, { active: true }));
      await show(page, 600, 400, "notes", notesCss, `<div style="height:calc(100dvh - 48px);display:flex;overflow:hidden">${html}</div>`);
      const pane = page.locator('[aria-label="Note"]');
      expect(await pane.evaluate(element => getComputedStyle(element).overflowY)).toBe("auto");
      await page.getByRole("button", { name: error ? "Try again" : "Create a note" }).scrollIntoViewIfNeeded();
      const action = await page.getByRole("button", { name: error ? "Try again" : "Create a note" }).boundingBox();
      expect(action!.y + action!.height).toBeLessThanOrEqual(352);
      expect(action!.height).toBeGreaterThanOrEqual(44);
      const artwork = await pane.locator("img").boundingBox();
      expect(artwork!.height).toBe(88);
    } finally { await page.close(); }
  });
});
