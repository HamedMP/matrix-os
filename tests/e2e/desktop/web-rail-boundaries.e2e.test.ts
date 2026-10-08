// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { ChatRailSection } from "@matrix-os/ui";
import { RenameableConversationRow } from "../../../shell/src/components/chat/ChatTitleRename";
import { loadOrganizationDriveOptions } from "../../../packages/ui/src/organization-drive/discovery";
import { OrganizationDrivesNavigation } from "../../../packages/ui/src/organization-drive/OrganizationDrivesNavigation";
vi.mock("../../../packages/ui/src/organization-drive/discovery", () => ({
  loadOrganizationDriveOptions: vi.fn(async () => [{scopeId:"fixture",organizationId:"org_fixture",name:"Fixture",state:"ready",canManage:false}]),
}));
const { chromium } = createRequire(resolve(__dirname, "../../../shell/package.json"))("@playwright/test");
let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await readFile(resolve(__dirname, "../../../packages/ui/src/chat-agents/chat-agents.css"), "utf8")
    + await readFile(resolve(__dirname, "../../../packages/ui/src/chat/overflowing-chat-title.css"), "utf8");
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
});
afterEach(cleanup);
afterAll(async () => browser?.close());
const utilities = `*{box-sizing:border-box}body{margin:0}aside{width:240px}button{border:0;background:none;font-family:Arial}.flex{display:flex}.items-center{align-items:center}.min-w-0{min-width:0}.flex-1{flex:1}.w-full{width:100%}.gap-2{gap:8px}.mb-2{margin-bottom:8px}.mx-2{margin-left:8px;margin-right:8px}.min-h-9{min-height:36px}`;

it("uses full quiet Web title width and shrinks only for hover/focus/open-menu actions", async () => {
  const page = await browser.newPage({viewport:{width:600,height:400}});
  try {
    const title = "Long Web title that should use all quiet row space ".repeat(3);
    const markup = renderToStaticMarkup(React.createElement(RenameableConversationRow, {
      conversation:{id:"web_width",title,preview:"",messageCount:1,updatedAt:1},active:false,mobile:false,editing:false,renamePending:false,
      onSelect:()=>{},onRenameStart:()=>{},onRenameCommit:()=>{},onRenameCancel:()=>{},
    }));
    await page.setContent(`<style>${utilities}${css}</style><aside>${markup}</aside>`);
    const row = page.locator(".matrix-web-chat-row-item");
    const text = row.locator(".matrix-chat-title-text");
    const measure = () => row.evaluate(el => {
      const viewport = el.querySelector(".matrix-chat-title-viewport")!.getBoundingClientRect();
      const action = el.querySelector(".matrix-web-chat-row-more")!;
      return {left:viewport.left,right:viewport.right,width:viewport.width,actionLeft:action.getBoundingClientRect().left,opacity:getComputedStyle(action).opacity};
    });
    // SSR isolates CSS; real DOM measurements stand in for the separately tested ResizeObserver effect.
    const refresh = () => row.locator(".matrix-chat-title-viewport").evaluate(viewport => {
      const text=viewport.querySelector("span")!;
      const distance=Math.max(0,text.scrollWidth-viewport.clientWidth);
      viewport.setAttribute("data-overflowing",String(distance>0));
      (viewport as HTMLElement).style.setProperty("--chat-title-scroll-distance",`${distance}px`);
    });
    for (const width of [240,200]) {
      await page.locator("aside").evaluate((aside,width)=>{aside.style.width=`${width}px`;},width);
      await row.evaluate(el=>el.removeAttribute("data-menu-open"));
      await page.mouse.move(500,350); await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());
      await refresh();
      const quiet=await measure();
      expect(quiet.opacity).toBe("0");expect(quiet.right).toBeGreaterThan(quiet.actionLeft);
      expect(await text.evaluate(el=>el.getAnimations().length)).toBe(0);
      await row.hover();await refresh();
      const hover=await measure();
      expect(hover.opacity).toBe("1");expect(hover.width).toBeLessThan(quiet.width);expect(hover.left).toBe(quiet.left);expect(hover.right).toBeLessThanOrEqual(hover.actionLeft);
      await text.evaluate(el=>{const animation=el.getAnimations()[0];if(!animation)throw new Error("Missing hover scroll");animation.pause();animation.currentTime=2000;});
      expect(await text.evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).m41)).toBeLessThan(0);
      await text.evaluate(el=>el.getAnimations().forEach(animation=>animation.cancel()));
      await page.mouse.move(500,350);await row.locator(".matrix-web-chat-row").focus();
      expect((await measure()).width).toBe(hover.width);
      await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());await row.evaluate(el=>el.setAttribute("data-menu-open","true"));
      const menu=await measure();expect(menu.opacity).toBe("1");expect(menu.width).toBe(hover.width);expect(menu.right).toBeLessThanOrEqual(menu.actionLeft);
      expect(await text.evaluate(el=>el.getAnimations().length)).toBe(0);
      await page.emulateMedia({reducedMotion:"reduce"});expect(await text.evaluate(el=>el.getAnimations().length)).toBe(0);
      await page.emulateMedia({reducedMotion:"no-preference"});
    }
  } finally {await page.close();}
});

it("keeps the actual Company drives wrapper boundary at 2px before Needs you", async () => {
  const view = render(React.createElement("aside", null,
    React.createElement(OrganizationDrivesNavigation,{api:{} as never,onOpen:()=>{}}),
    React.createElement(ChatRailSection,{label:"Needs you",count:0,expanded:true,onExpandedChange:()=>{},children:null})));
  await screen.findByRole("button",{name:"Open Fixture drive"});
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>${utilities}${css}</style>${view.container.innerHTML}`);
    const row = await page.getByRole("button",{name:"Open Fixture drive"}).boundingBox();
    const frame = await page.getByRole("button",{name:"Needs you"}).locator("..").boundingBox();
    expect(frame!.y-(row!.y+row!.height)).toBe(2);
  } finally {await page.close();}
});


it("reserves space for the permanently visible Web actions on touch", async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 400 }, hasTouch: true, isMobile: true });
  try {
    const markup = renderToStaticMarkup(React.createElement(RenameableConversationRow, {
      conversation: { id: "touch_width", title: "Long touch title ".repeat(10), preview: "", messageCount: 1, updatedAt: 1 },
      active: false, mobile: false, editing: false, renamePending: false,
      onSelect: () => {}, onRenameStart: () => {}, onRenameCommit: () => {}, onRenameCancel: () => {},
    }));
    await page.setContent(`<style>${utilities}${css}</style><aside>${markup}</aside>`);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    for (const width of [240, 200]) {
      await page.locator("aside").evaluate((aside, width) => { aside.style.width = `${width}px`; }, width);
      const geometry = await page.locator(".matrix-web-chat-row-item").evaluate(row => {
        const title = row.querySelector(".matrix-chat-title-viewport")!.getBoundingClientRect();
        const action = row.querySelector(".matrix-web-chat-row-more")!;
        return { titleRight: title.right, actionLeft: action.getBoundingClientRect().left, opacity: getComputedStyle(action).opacity, pointerEvents: getComputedStyle(action).pointerEvents };
      });
      expect(geometry.opacity).toBe("1");
      expect(geometry.pointerEvents).toBe("auto");
      expect(geometry.titleRight).toBeLessThanOrEqual(geometry.actionLeft);
    }
  } finally { await page.close(); }
});


it("scrolls long Company drive titles in their existing full-width navigation button", async () => {
  const name = "Long Company drive title ".repeat(8).trim();
  vi.mocked(loadOrganizationDriveOptions).mockResolvedValueOnce([{ scopeId: "long_drive", organizationId: "org_fixture", name, state: "ready", canManage: false }]);
  const view = render(React.createElement(OrganizationDrivesNavigation, { api: {} as never, onOpen: () => {}, onSelectChat: () => {} }));
  await screen.findByRole("button", { name: `Open ${name} drive` });
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  try {
    await page.setContent(`<style>${utilities}${css}.px-2{padding-left:8px;padding-right:8px}.shrink-0{flex-shrink:0}</style><aside>${view.container.innerHTML}</aside>`);
    const row = page.locator(".matrix-drive-rail-item");
    const button = page.getByRole("button", { name: `Open ${name} drive` });
    const viewport = button.locator(".matrix-chat-title-viewport");
    expect(await viewport.count()).toBe(1);
    for (const width of [240, 200]) {
      await page.locator("aside").evaluate((aside, width) => { aside.style.width = `${width}px`; }, width);
      await page.mouse.move(500, 350); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      const quiet = await button.boundingBox();
      expect((await viewport.boundingBox())!.x + (await viewport.boundingBox())!.width).toBe(quiet!.x + quiet!.width - 8);
      await viewport.evaluate(viewport => {
        const text = viewport.querySelector("span")!;
        const distance = Math.max(0, text.scrollWidth - viewport.clientWidth);
        viewport.setAttribute("data-overflowing", String(distance > 0));
        (viewport as HTMLElement).style.setProperty("--chat-title-scroll-distance", `${distance}px`);
      });
      const text = viewport.locator("span");
      expect(await text.evaluate(text => text.getAnimations().length)).toBe(0);
      await row.hover();
      await text.evaluate(text => { const animation = text.getAnimations()[0]; if (!animation) throw new Error("Missing drive title scroll"); animation.pause(); animation.currentTime = 2000; });
      expect(await text.evaluate(text => new DOMMatrix(getComputedStyle(text).transform).m41)).toBeLessThan(0);
      expect(await button.boundingBox()).toEqual(quiet);
      await text.evaluate(text => text.getAnimations().forEach(animation => animation.cancel()));
      await page.mouse.move(500, 350); await button.focus();
      expect(await text.evaluate(text => text.getAnimations().length)).toBe(1);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await text.evaluate(text => text.getAnimations().length)).toBe(0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  } finally { await page.close(); }
});
