import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { WorkRailProjectGroup } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailProjectGroup";
import { WorkRailSection } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailSection";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation";
import { clientFixture } from "../../desktop/chat-agents-fixture";

vi.mock("../../../desktop/src/renderer/src/features/work/work-rail/use-project-actions", () => ({
  useProjectActions: () => ({ available: true, pending: false, update: vi.fn(), showInFiles: vi.fn(), setDialog: vi.fn(), dialog: null, error: null }),
}));
vi.mock("../../../packages/ui/src/chat-agents/bots/use-agent-rail-library.js", () => ({
  useAgentRailLibrary: () => ({ enabled: true, agents: [] }),
}));
const { chromium } = createRequire(new URL("../../../shell/package.json", import.meta.url))("@playwright/test");
let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await readFile(new URL("../../../desktop/src/renderer/src/features/work/work-rail/work-rail.css", import.meta.url), "utf8")
    + await readFile(new URL("../../../packages/ui/src/chat-agents/chat-agents.css", import.meta.url), "utf8");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => browser?.close());

it("aligns pinned/unpinned project icons and labels and contains disclosure/action hit targets", async () => {
  const page = await browser.newPage({ viewport: {width:600,height:700} });
  const project = (pinned: boolean) => {
    const name = pinned ? "Pinned project with a long title" : "Ordinary project with a long title";
    const model = {id:name, slug:name, name, chats:[], project:{slug:name,name,pinned}};
    const noop = () => {};
    return React.createElement(WorkRailProjectGroup, {
      group:model, expanded:false,pinning:{},onToggle:noop,onSelect:noop,onNewChat:noop,onDeleteProject:noop,
      onSelectChat:noop,renamingChatId:null,renamePending:false,onRenameChat:noop,onRenameCommit:noop,
      onRenameCancel:noop,onPinChat:noop,onDeleteChat:noop,
    });
  };
  try {
    const markup = renderToStaticMarkup(React.createElement("nav", {className:"matrix-chat-work-rail"},
      React.createElement(WorkRailSection,{label:"Pinned",expanded:true,onToggle:()=>{},children:project(true)}),
      React.createElement(WorkRailSection,{label:"Projects",expanded:true,onToggle:()=>{},children:project(false)})));
    await page.setContent(`<style>${css} *{box-sizing:border-box} body{margin:0} nav{width:240px;padding:0 10px} button{border:0;background:none;font-family:Arial} .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>${markup}`);
    const result = await page.locator('[class~="group/project"]').evaluateAll(rows => rows.map(row => {
      const main = row.querySelector<HTMLButtonElement>("button:not([aria-expanded]):not([aria-haspopup]):not([title])")!;
      const label = main.querySelector("span")!.getBoundingClientRect();
      const icon = main.querySelector("svg")!.getBoundingClientRect();
      const disclosure = row.querySelector<HTMLButtonElement>("[aria-expanded]")!.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      return {iconX:icon.x,labelX:label.x,right:rect.right,disclosureRight:disclosure.right};
    }));
    expect(result).toHaveLength(2);
    for (const row of result) {
      expect(row.iconX).toBe(20);
      expect(row.labelX).toBe(45);
      expect(row.disclosureRight).toBeLessThanOrEqual(row.right - 8);
    }
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>(".work-rail-project [aria-expanded]").forEach(button => button.addEventListener("click", () => button.setAttribute("aria-expanded", "true")));
    });
    for (const name of ["Pinned project with a long title", "Ordinary project with a long title"]) {
      await page.getByRole("button",{name:`Expand ${name} chats`,exact:true}).click({timeout:1500});
      expect(await page.getByRole("button",{name:`Expand ${name} chats`,exact:true}).getAttribute("aria-expanded")).toBe("true");
      await page.getByRole("button",{name,exact:true}).hover();
      await page.getByRole("button",{name:`New chat in ${name}`,exact:true}).click({trial:true,timeout:1500});
      await page.getByRole("button",{name:`Actions for ${name}`,exact:true}).click({trial:true,timeout:1500});
    }
    const headings = await page.locator('[data-slot="chat-sidebar-section-heading"] button').evaluateAll(buttons => buttons.map(button => {
      const rect=button.getBoundingClientRect(); const icon=button.querySelector("svg")!.getBoundingClientRect();
      return {right:rect.right,iconRight:icon.right};
    }));
    for (const heading of headings) expect(heading.iconRight).toBeLessThan(heading.right);
  } finally {await page.close();}
});

it("keeps actual Agent disclosure beside its label and actions contained on hover and focus", async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  try {
    const projectHeading = renderToStaticMarkup(React.createElement(WorkRailSection, {label:"Projects",expanded:true,onToggle:()=>{},children:null}));
    const agentHeading = renderToStaticMarkup(React.createElement(ChatAgentsWorkspace, {},
      React.createElement(ChatAgentsRailSection, {client:clientFixture(),expanded:true})));
    await page.setContent(`<style>${css} *{box-sizing:border-box} body{margin:0;font-family:Arial} button{border:0;padding:0} .ml-auto{margin-left:auto} [class~="mr-2.5"]{margin-right:10px}</style>
      <nav class="matrix-chat-work-rail" style="width:240px;padding:0 10px">${agentHeading}${projectHeading}</nav>`);
    const heading = page.locator(".matrix-chat-agents-group-heading");
    const controls = heading.locator(".matrix-chat-agents-disclosure, .matrix-chat-agents-create");
    const disclosure = page.getByRole("button", {name:"Collapse agents",exact:true});
    const create = page.getByRole("button", {name:"Add new agent",exact:true});
    const agent = page.getByRole("button", {name:"Agents",exact:true});
    for (const width of [240,200]) {
      await page.locator("nav").evaluate((nav,width) => { (nav as HTMLElement).style.width = `${width}px`; },width);
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.mouse.move(550,650);
      const quiet = await controls.evaluateAll(buttons => buttons.map(button => ({opacity:getComputedStyle(button).opacity,pointer:getComputedStyle(button).pointerEvents})));
      expect(quiet).toEqual([{opacity:"0",pointer:"none"},{opacity:"0",pointer:"none"}]);
      const geometry = await heading.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const label = node.querySelector(".matrix-chat-agents-heading > span")!.getBoundingClientRect();
        const glyph = node.querySelector(".matrix-chat-agents-disclosure svg")!.getBoundingClientRect();
        const buttons = Array.from(node.querySelectorAll(".matrix-chat-agents-disclosure, .matrix-chat-agents-create"), button => {
          const box = button.getBoundingClientRect();
          return {width:box.width,height:box.height,left:box.left,right:box.right,top:box.top,bottom:box.bottom};
        });
        return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,labelRight:label.right,glyphGap:glyph.left-label.right,buttons};
      });
      expect(geometry.buttons).toHaveLength(2);
      expect(geometry.glyphGap).toBeCloseTo(6,3);
      expect(geometry.buttons[0].left).toBeCloseTo(geometry.labelRight,3);
      expect(geometry.buttons[0].right).toBeLessThan(geometry.buttons[1].left);
      expect(geometry.buttons[1].right).toBeCloseTo(geometry.right-8,3);
      for (const button of geometry.buttons) {
        expect(button.width).toBe(24);
        expect(button.height).toBe(24);
        expect(button.left).toBeGreaterThanOrEqual(geometry.left);
        expect(button.right).toBeLessThanOrEqual(geometry.right);
        expect(button.top).toBeGreaterThanOrEqual(geometry.top);
        expect(button.bottom).toBeLessThanOrEqual(geometry.bottom);
      }
      await agent.hover();
      expect(await controls.evaluateAll(buttons => buttons.map(button => getComputedStyle(button).pointerEvents))).toEqual(["auto","auto"]);
      await create.click({timeout:1500});
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Add new agent");
      await disclosure.click({timeout:1500});
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Collapse agents");
      await page.mouse.move(550,650);
      await agent.focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Collapse agents");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Add new agent");
      expect(await controls.evaluateAll(buttons => buttons.map(button => getComputedStyle(button).opacity))).toEqual(["1","1"]);
    }
  } finally {await page.close();}
});
