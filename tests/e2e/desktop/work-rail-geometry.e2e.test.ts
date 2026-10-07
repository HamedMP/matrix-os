import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { WorkRailProjectGroup } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailProjectGroup";
import { WorkRailSection } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailSection";

vi.mock("../../../desktop/src/renderer/src/features/work/work-rail/use-project-actions", () => ({
  useProjectActions: () => ({ available: true, pending: false, update: vi.fn(), showInFiles: vi.fn(), setDialog: vi.fn(), dialog: null, error: null }),
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
  expect(css).toMatch(/\.work-rail-project:hover \.work-rail-project-actions \{ background: linear-gradient\(var\(--bg-hover\), var\(--bg-hover\)\), var\(--bg-surface\); \}/);
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

it("does not stretch shared Agent heading actions when applying section disclosure geometry", async () => {
  const page = await browser.newPage();
  try {
    const projectHeading = renderToStaticMarkup(React.createElement(WorkRailSection, {label:"Projects",expanded:true,onToggle:()=>{},children:null}));
    await page.setContent(`<style>${css} *{box-sizing:border-box} body{margin:0} button{border:0;padding:0} .ml-auto{margin-left:auto} [class~="mr-2.5"]{margin-right:10px} .matrix-chat-agent-button{display:grid;place-items:center}</style>
      <nav class="matrix-chat-work-rail" style="width:240px;padding:0 10px"><section class="matrix-chat-agents-rail">
        <div data-slot="chat-sidebar-section-heading" style="display:flex;width:100%">
          <button aria-label="Agents" class="matrix-chat-agents-heading" style="flex:1;min-width:0">Agents</button>
          <button aria-label="Add new agent" class="matrix-chat-agents-create" style="flex-shrink:0">+</button>
          <button aria-label="Collapse Agents" class="matrix-chat-agent-button" style="flex-shrink:0"><svg width="12" height="12" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
        </div></section>${projectHeading}</nav>`);
    const geometry = await page.locator("button").evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect(); return {width:rect.width,right:rect.right};
    }));
    expect(geometry[1].width).toBe(20);
    expect(geometry[2].right).toBe(222);
    for (const width of [240,200]) {
      await page.locator("nav").evaluate((nav,width) => { (nav as HTMLElement).style.width = `${width}px`; },width);
      const centers = await page.locator('[aria-label="Collapse Agents"] svg, .work-rail-section-disclosure svg').evaluateAll(icons => icons.map(icon => {
        const rect = icon.getBoundingClientRect(); return rect.x + rect.width / 2;
      }));
      expect(centers).toHaveLength(2);
      expect(centers[0]).toBe(centers[1]);
      expect(centers[0]).toBeLessThan(width - 10);
    }
    await page.getByRole("button", {name:"Add new agent"}).click({timeout:1500});
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Add new agent");
    await page.getByRole("button", {name:"Collapse Agents"}).click({timeout:1500});
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Collapse Agents");
  } finally {await page.close();}
});
