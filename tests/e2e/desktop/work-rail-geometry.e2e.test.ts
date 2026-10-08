import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { WorkRailProjectGroup } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailProjectGroup";
import { WorkRailSection } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailSection";
import { WorkRailChatRow } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailChatRow";
import { ChatRailSection } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
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
    + await readFile(new URL("../../../packages/ui/src/chat-agents/chat-agents.css", import.meta.url), "utf8")
    + await readFile(new URL("../../../packages/ui/src/chat/overflowing-chat-title.css", import.meta.url), "utf8");
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
      key:name, group:model, expanded:false,pinning:{},onToggle:noop,onSelect:noop,onNewChat:noop,onDeleteProject:noop,
      onSelectChat:noop,renamingChatId:null,renamePending:false,onRenameChat:noop,onRenameCommit:noop,
      onRenameCancel:noop,onPinChat:noop,onDeleteChat:noop,
    });
  };
  try {
    const markup = renderToStaticMarkup(React.createElement("nav", {className:"matrix-chat-work-rail"},
      React.createElement(WorkRailSection,{label:"Pinned",expanded:true,onToggle:()=>{},children:[project(true), React.createElement(WorkRailChatRow,{key:"chat",record:{chat:{id:"chat_pinned_geometry",title:"Pinned chat",attention:"none",userState:{pinned:true}}} as CanonicalChatRecord,active:false,pinning:false,placement:"pinned",onSelect:()=>{},renaming:false,renamePending:false,renameDisabled:false,onRenameStart:()=>{},onRenameCommit:()=>{},onRenameCancel:()=>{},onPin:()=>{},onDelete:()=>{}})]}),
      React.createElement(WorkRailSection,{label:"Projects",expanded:true,onToggle:()=>{},children:project(false)})));
    await page.setContent(`<style>${css} *{box-sizing:border-box} body{margin:0} nav{width:240px;padding:0 10px} button{border:0;background:none;font-family:Arial} .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .work-rail-chat>button{display:flex;align-items:center;gap:10px;width:100%}.work-rail-chat>button>svg{flex-shrink:0}</style>${markup}`);
    for (const width of [240, 200]) {
      await page.locator("nav").evaluate((nav, width) => { nav.style.width = `${width}px`; }, width);
      const result = await page.locator('[class~="group/project"]').evaluateAll(rows => rows.map(row => {
        const main = row.querySelector<HTMLButtonElement>(".work-rail-project-select")!;
        const label = main.querySelector("span")!.getBoundingClientRect();
        const icon = main.querySelector("svg")!.getBoundingClientRect();
        const disclosure = row.querySelector<HTMLButtonElement>("[aria-expanded]")!.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        return {iconX:icon.x,labelX:label.x,right:rect.right,disclosureRight:disclosure.right};
      }));
      const chat = await page.locator(".work-rail-chat > button").evaluate(button => ({iconX:button.querySelector("svg")!.getBoundingClientRect().x,labelX:button.querySelector(".work-rail-chat-label")!.getBoundingClientRect().x}));
      expect(result).toHaveLength(2);
      for (const row of result) {
        expect(row.iconX).toBe(chat.iconX);
        expect(row.labelX).toBe(chat.labelX);
        expect(row.disclosureRight).toBeLessThanOrEqual(row.right - 8);
      }
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>(".work-rail-project [aria-expanded]").forEach(button => button.addEventListener("click", () => button.setAttribute("aria-expanded", "true")));
      });
      for (const name of ["Pinned project with a long title", "Ordinary project with a long title"]) {
        await page.getByRole("button",{name,exact:true}).hover();
        await page.getByRole("button",{name:`Expand ${name} chats`,exact:true}).click({timeout:1500});
        expect(await page.getByRole("button",{name:`Expand ${name} chats`,exact:true}).getAttribute("aria-expanded")).toBe("true");
        await page.getByRole("button",{name,exact:true}).hover();
        await page.getByRole("button",{name:`New chat in ${name}`,exact:true}).click({trial:true,timeout:1500});
        await page.getByRole("button",{name:`Actions for ${name}`,exact:true}).click({trial:true,timeout:1500});
      }
    }
    const headings = await page.locator('[data-slot="chat-sidebar-section-heading"] button').evaluateAll(buttons => buttons.map(button => {
      const rect=button.getBoundingClientRect(); const icon=button.querySelector("svg")!.getBoundingClientRect();
      return {right:rect.right,iconRight:icon.right};
    }));
    for (const heading of headings) expect(heading.iconRight).toBeLessThan(heading.right);
  } finally {await page.close();}
});

it("keeps header disclosure beside the label and quiet until hover or focus", async () => {
  const page = await browser.newPage();
  try {
    const heading = renderToStaticMarkup(React.createElement(WorkRailSection, {label:"Working",count:2,expanded:false,onToggle:()=>{},children:null}));
    await page.setContent(`<style>${css} *{box-sizing:border-box} body{margin:0} button{border:0;background:none;font-family:Arial}</style><nav class="matrix-chat-work-rail" style="width:240px;padding:0 10px">${heading}</nav>`);
    const button = page.getByRole("button", {name:"Working",exact:true});
    const arrow = button.locator(".work-rail-section-disclosure");
    expect(await arrow.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    for (const width of [240,200]) {
      await page.locator("nav").evaluate((nav,width) => { (nav as HTMLElement).style.width = `${width}px`; },width);
      const before = await button.boundingBox();
      await button.hover();
      expect(await arrow.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
      const result = await button.evaluate(el => {
        const label = el.querySelector("span")!.getBoundingClientRect();
        const arrow = el.querySelector(".work-rail-section-disclosure")!.getBoundingClientRect();
        return { gap: arrow.left-label.right, right: arrow.right, width: el.getBoundingClientRect().width };
      });
      expect(result.gap).toBe(4);
      expect(result.right).toBeLessThan(width-10);
      expect((await button.boundingBox())?.width).toBe(before?.width);
    }
    await page.mouse.move(500,500);
    await button.focus();
    expect(await arrow.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
  } finally {await page.close();}
});

it("uses full quiet Chat title width and reserves visible hover/focus/menu actions while scrolling", async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
  const noop = () => {};
  const rows = ["normal", "pinned", "running", "project"].map(kind => {
    const title = `${kind} Chat with a very long title that must ellipsize before its actions`;
    const record = {
      chat: { id: kind, title, ownerScope: { type: "personal", ownerId: "owner" }, attention: "none", lifecycle: "active", revision: 1, messageCount: 0, userState: { pinned: kind === "pinned" }, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" },
      ...(kind === "running" ? { activeRun: { runId: "run_running", turnId: "turn_running", status: "running" } } : {}),
    } as CanonicalChatRecord;
    return React.createElement(WorkRailChatRow, {
      key: kind, record, active: kind === "pinned", pinning: false, placement: kind === "pinned" ? "pinned" : kind === "project" ? "project" : "recent",
      onSelect: noop, renaming: false, renamePending: false, renameDisabled: false,
      onRenameStart: noop, onRenameCommit: noop, onRenameCancel: noop, onPin: noop, onDelete: noop,
    });
  });
  try {
    // Match the row's Tailwind layout utilities; load its actual product CSS above.
    const utilities = `*{box-sizing:border-box} body{margin:0} nav{width:240px;padding:0 10px} button{border:0;background:none;font-family:Arial}
      .flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}.min-w-0{min-width:0}.flex-1{flex:1 1 0%}.w-full{width:100%}.shrink-0{flex-shrink:0}
      .relative{position:relative}.absolute{position:absolute}.right-1{right:4px}.top-1\\/2{top:50%}.-translate-y-1\\/2{transform:translateY(-50%)}
      .gap-2\\.5{gap:10px}.gap-0\\.5{gap:2px}.size-6{width:24px;height:24px}.size-\\[6px\\]{width:6px;height:6px}.ml-auto{margin-left:auto}
      .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.opacity-0{opacity:0}.pointer-events-none{pointer-events:none}
      .work-rail-chat:hover .work-rail-chat-actions,.work-rail-chat:focus-within .work-rail-chat-actions{opacity:1;pointer-events:auto}`;
    await page.setContent(`<style>${utilities}${css}</style>${renderToStaticMarkup(React.createElement("nav", { className: "matrix-chat-work-rail" }, rows))}`);
    const measure = (row: import("playwright").Locator) => row.evaluate(el => {
      const title = el.querySelector(".work-rail-chat-label .matrix-chat-title-viewport")!.getBoundingClientRect();
      const actions = el.querySelector(".work-rail-chat-actions")!;
      return { left: title.left, right: title.right, width: title.width, actionsLeft: actions.getBoundingClientRect().left, opacity: getComputedStyle(actions).opacity };
    });
    for (const width of [240, 200]) {
      await page.locator("nav").evaluate((nav, value) => { nav.style.width = `${value}px`; }, width);
      const normalTitle = await page.locator('.work-rail-chat').first().locator('.matrix-chat-title-viewport').boundingBox();
      const childTitle = await page.locator('.work-rail-chat[data-placement="project"] .matrix-chat-title-viewport').boundingBox();
      expect(childTitle!.x - normalTitle!.x).toBe(14);
      // SSR has no effects: apply actual DOM measurements here to isolate product CSS.
      // The unit test covers the shared component's ResizeObserver and rename measurement.
      await page.locator(".matrix-chat-title-viewport").evaluateAll(viewports => viewports.forEach(viewport => {
        const text = viewport.querySelector<HTMLElement>(".matrix-chat-title-text")!;
        const distance = Math.max(0, text.scrollWidth - viewport.clientWidth);
        (viewport as HTMLElement).style.setProperty("--chat-title-scroll-distance", `${distance}px`);
        viewport.setAttribute("data-overflowing", String(distance > 0));
      }));
      for (const row of await page.locator(".work-rail-chat").all()) {
        await page.mouse.move(500, 400);
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        const text = row.locator(".matrix-chat-title-text");
        const before = await measure(row);
        expect(await text.evaluate(el => getComputedStyle(el).textOverflow)).toBe("ellipsis");
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
        expect(before.opacity).toBe("0");
        expect(before.right).toBeGreaterThan(before.actionsLeft);
        await row.hover();
        const hover = await measure(row);
        await row.evaluate(el => el.setAttribute("data-menu-open", "true"));
        await row.hover();
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
        expect((await measure(row)).width).toBe(hover.width);
        await row.evaluate(el => el.removeAttribute("data-menu-open"));
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(1);
        await text.evaluate(el => { const animation = el.getAnimations()[0]; if (!animation) throw new Error("Missing hover scroll"); animation.pause(); animation.currentTime = 2000; });
        expect(await text.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeLessThan(0);
        expect(hover.opacity).toBe("1");
        expect(hover.right).toBeLessThanOrEqual(hover.actionsLeft);
        expect(hover.left).toBe(before.left);
        expect(hover.width).toBeLessThan(before.width);
        await text.evaluate(el => el.getAnimations().forEach(animation => animation.cancel()));
        await page.mouse.move(500, 400);
        await row.locator("button").first().focus();
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(1);
        const focus = await measure(row);
        expect(focus.opacity).toBe("1");
        expect(focus.right).toBeLessThanOrEqual(focus.actionsLeft);
        expect([focus.left, focus.right, focus.width]).toEqual([hover.left, hover.right, hover.width]);
        await row.evaluate(el => el.setAttribute("data-menu-open", "true"));
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
        await row.evaluate(el => el.removeAttribute("data-menu-open"));
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(1);
        await page.mouse.move(500,400);
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await row.evaluate(el => el.setAttribute("data-menu-open", "true"));
        const opened = await measure(row);
        expect(opened.opacity).toBe("1");
        expect(opened.right).toBeLessThanOrEqual(opened.actionsLeft);
        expect(opened.width).toBe(hover.width);
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
        expect(await text.evaluate(el => getComputedStyle(el).textOverflow)).toBe("ellipsis");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await row.evaluate(el => el.removeAttribute("data-menu-open"));
      }
      await page.mouse.move(500, 400);
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      const indicator = page.locator('[aria-label^="Agent running for"]');
      expect(await indicator.isVisible()).toBe(true);
      const dot = await indicator.boundingBox();
      expect(dot?.width).toBe(6);
      expect(dot?.height).toBe(6);
    }
  } finally { await page.close(); }
});

it("matches Figma 40px frames, 24px triggers and 2px content spacing in every disclosure state", async () => {
  const page = await browser.newPage();
  try {
    const sections = [
      React.createElement(WorkRailSection, { key:"empty", label:"Needs you", count:0, expanded:true, onToggle:()=>{}, children:null }),
      React.createElement(WorkRailSection, { key:"closed", label:"Working", count:2, expanded:false, onToggle:()=>{}, children:React.createElement("button", null, "Hidden working chat") }),
      React.createElement(WorkRailSection, { key:"done", label:"Done", count:3, expanded:false, onToggle:()=>{}, children:React.createElement("button", null, "Hidden Done chat") }),
      React.createElement(WorkRailSection, { key:"open", label:"Pinned", count:1, expanded:true, onToggle:()=>{}, children:React.createElement("button", {"data-row":"pinned",style:{height:32}}, "Pinned chat") }),
      React.createElement(WorkRailSection, { key:"next", label:"Next", count:0, expanded:true, onToggle:()=>{}, children:null }),
    ];
    const utilities = `*{box-sizing:border-box} body{margin:0} nav{width:240px;display:flex;flex-direction:column;gap:2px} button{border:0;background:none;font-family:Arial}.flex{display:flex}.flex-col{flex-direction:column}.gap-0\\.5{gap:2px}.mb-1{margin-bottom:4px}.grid{display:grid}.min-h-0{min-height:0}.overflow-hidden{overflow:hidden}`;
    await page.setContent(`<style>${css}${utilities}</style>${renderToStaticMarkup(React.createElement("nav", {className:"matrix-chat-work-rail"}, sections))}`);
    const layout = await page.locator("nav > section").evaluateAll(sections => sections.map(section => {
      const heading = section.querySelector(".work-rail-section-heading")!;
      const toggle = heading.querySelector("button")!;
      const collapse = section.querySelector('[data-slot="chat-rail-collapse"]')!;
      return { top:section.getBoundingClientRect().top, height:section.getBoundingClientRect().height, headingTop:toggle.getBoundingClientRect().top, collapseHeight:collapse.getBoundingClientRect().height, frameHeight:heading.getBoundingClientRect().height, triggerHeight:toggle.getBoundingClientRect().height };
    }));
    for (const index of [0,1]) {
      expect(layout[index+1].top-layout[index].top).toBe(42);
      expect(layout[index].height).toBe(40);
      expect(layout[index].collapseHeight).toBe(0);
    }
    expect(layout[2].collapseHeight).toBe(0);
    expect(layout[3].headingTop-layout[3].top).toBe(12);
    for (const item of layout) { expect(item.frameHeight).toBe(40); expect(item.triggerHeight).toBe(24); }
    const pinnedRow = await page.locator('[data-row="pinned"]').boundingBox();
    expect(pinnedRow!.y - (layout[3].top + 40)).toBe(2);
    expect(layout[4].top - (pinnedRow!.y + pinnedRow!.height)).toBe(2);
    const headingSpacing = (section: Element) => {
      const heading = section.querySelector("button")!;
      const style = getComputedStyle(heading);
      const frame = section.querySelector(".work-rail-section-heading, .matrix-chat-rail-section-header")!;
      const container = getComputedStyle(frame);
      return {height:heading.getBoundingClientRect().height, padding:style.padding, margin:style.margin, sectionPadding:container.padding, sectionMargin:container.margin, triggerY:heading.getBoundingClientRect().top - frame.getBoundingClientRect().top, frameHeight:frame.getBoundingClientRect().height};
    };
    const expandedSpacing = await page.locator("nav > section").nth(3).evaluate(headingSpacing);
    await page.locator("nav > section").nth(3).evaluate(section => {
      section.setAttribute("data-expanded", "false");
      section.querySelector("button")!.setAttribute("aria-expanded", "false");
      (section.querySelector('[data-slot="chat-rail-collapse"]') as HTMLElement).style.gridTemplateRows = "0fr";
    });
    expect(await page.locator("nav > section").nth(3).evaluate(headingSpacing)).toEqual(expandedSpacing);
    await page.setContent(`<style>${css}${utilities}</style>${renderToStaticMarkup(React.createElement("nav", {className:"matrix-chat-work-rail"}, React.createElement(WorkRailSection, {label:"Projects",count:3,expanded:false,onToggle:()=>{},action:React.createElement("button",{className:"work-rail-group-create","aria-label":"Create project"},"+"),children:null})))}`);
    const project = page.getByRole("button", {name:"Projects",exact:true});
    expect(await project.evaluate(el=>getComputedStyle(el).textTransform)).toBe("uppercase");
    expect(await project.evaluate(el=>getComputedStyle(el).fontSize)).toBe("11px");
    const actionBounds = await page.getByRole("button", {name:"Create project"}).boundingBox();
    const countBounds = await page.getByLabel("3 hidden items").boundingBox();
    expect(countBounds!.x + countBounds!.width).toBeLessThanOrEqual(actionBounds!.x);
    expect(actionBounds!.height).toBe(24);
    const projectFrame = await page.locator('.work-rail-section-heading').boundingBox();
    expect(actionBounds!.y-projectFrame!.y).toBe(12);
    expect((await project.boundingBox())!.y-projectFrame!.y).toBe(12);
    await project.focus();
    await page.getByRole("button", {name:"Create project"}).click({trial:true});
    const shared = [
      React.createElement(ChatRailSection, {key:"empty",label:"Needs you",count:0,expanded:true,onExpandedChange:()=>{},children:null}),
      React.createElement(ChatRailSection, {key:"closed",label:"Working",count:2,expanded:false,onExpandedChange:()=>{},children:React.createElement("button",null,"Hidden Web chat")}),
      React.createElement(ChatRailSection, {key:"done",label:"Done",count:3,expanded:false,onExpandedChange:()=>{},children:React.createElement("button",null,"Hidden Web Done chat")}),
      React.createElement(ChatRailSection, {key:"open",label:"Pinned",count:1,expanded:true,onExpandedChange:()=>{},children:React.createElement("button",{"data-row":"web",style:{height:32}},"Visible Web pinned chat")}),
      React.createElement(ChatRailSection, {key:"next",label:"Next",count:0,expanded:true,onExpandedChange:()=>{},children:null}),
    ];
    await page.setContent(`<style>${css}${utilities}</style>${renderToStaticMarkup(React.createElement("nav", {style:{display:"block"}}, shared))}`);
    const sharedLayout = await page.locator(".matrix-chat-rail-section").evaluateAll(sections => sections.map(section=>({top:section.getBoundingClientRect().top,height:section.getBoundingClientRect().height})));
    expect(sharedLayout[1].top-sharedLayout[0].top).toBe(42);
    expect(sharedLayout[2].top-sharedLayout[1].top).toBe(42);
    expect(sharedLayout.slice(0,3).every(section=>section.height===40)).toBe(true);
    const webRow = await page.locator('[data-row="web"]').boundingBox();
    expect(webRow!.y - (sharedLayout[3].top+40)).toBe(2);
    expect(sharedLayout[4].top-(webRow!.y+webRow!.height)).toBe(2);
    const sharedSpacing = await page.locator(".matrix-chat-rail-section").nth(3).evaluate(headingSpacing);
    await page.locator(".matrix-chat-rail-section").nth(3).evaluate(section => {
      section.setAttribute("data-expanded", "false");
      section.querySelector("button")!.setAttribute("aria-expanded", "false");
      (section.querySelector(".matrix-chat-rail-section-body") as HTMLElement).hidden = true;
    });
    expect(await page.locator(".matrix-chat-rail-section").nth(3).evaluate(headingSpacing)).toEqual(sharedSpacing);
  } finally { await page.close(); }
});

it("gives Project titles full quiet width and reveals adjacent tree and action slots only when needed", async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
  const names = ["Pinned long project ".repeat(8), "Ordinary long project ".repeat(8), "Alpha", "Shared long project ".repeat(8)];
  const noop = () => {};
  const markup = renderToStaticMarkup(React.createElement("nav", null, names.map((name, index) =>
    React.createElement(WorkRailProjectGroup, {
      key: name, group: { id: name, slug: name, name, chats: [], project: { slug: name, name, pinned: index === 0 } },
      shared: index === 3, expanded: false, pinning: {}, onToggle: noop, onSelect: noop, onNewChat: noop, onDeleteProject: noop,
      onSelectChat: noop, renamingChatId: null, renamePending: false, onRenameChat: noop, onRenameCommit: noop,
      onRenameCancel: noop, onPinChat: noop, onDeleteChat: noop,
    }))));
  try {
    await page.setContent(`<style>${css}*{box-sizing:border-box}body{margin:0}nav{width:240px;padding:0 10px}button{border:0;background:none;font-family:Arial}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>${markup}`);
    for (const width of [240, 200]) {
      await page.locator("nav").evaluate((nav, width) => { nav.style.width = `${width}px`; }, width);
      for (const name of names) {
        const row = page.locator(".work-rail-project").filter({ has: page.getByRole("button", { name, exact: true }) });
        const measure = () => row.evaluate(row => {
          const label = row.querySelector(".work-rail-project-select > span")!.getBoundingClientRect();
          const rect = row.getBoundingClientRect();
          const disclosure = row.querySelector(".work-rail-project-disclosure")!;
          const actions = row.querySelector(".work-rail-project-actions")!;
          return { left: label.left, right: label.right, width: label.width, rowRight: rect.right,
            disclosureLeft: disclosure.getBoundingClientRect().left, disclosureRight: disclosure.getBoundingClientRect().right,
            actionLeft: actions.getBoundingClientRect().left, actionOpacity: getComputedStyle(actions).opacity,
            sharedLeft: row.querySelector('[aria-label="Shared project"]')?.getBoundingClientRect().left };
        });
        await page.mouse.move(500, 400); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        const quiet = await measure();
        expect(quiet.actionOpacity).toBe("0");
        if (quiet.sharedLeft !== undefined) expect(quiet.right).toBeLessThanOrEqual(quiet.sharedLeft);
        else if (name !== "Alpha") expect(quiet.right).toBe(quiet.rowRight - 8);
        await row.hover();
        const hover = await measure();
        expect(hover.actionOpacity).toBe("1");
        expect(hover.left).toBe(quiet.left);
        expect(hover.right).toBeLessThanOrEqual(hover.disclosureLeft);
        expect(hover.disclosureRight).toBeLessThanOrEqual(hover.actionLeft);
        if (name === "Alpha") expect(hover.disclosureLeft - hover.right).toBe(0);
        else {
          expect(hover.width).toBeLessThan(quiet.width);
          const viewport = row.locator(".matrix-chat-title-viewport");
          await viewport.evaluate(viewport => {
            const text = viewport.querySelector("span")!;
            const distance = Math.max(0, text.scrollWidth - viewport.clientWidth);
            viewport.setAttribute("data-overflowing", String(distance > 0));
            (viewport as HTMLElement).style.setProperty("--chat-title-scroll-distance", `${distance}px`);
          });
          const text = viewport.locator("span");
          const menuTrigger = row.locator(".work-rail-project-actions button").first();
          await menuTrigger.evaluate(button => button.setAttribute("data-state", "open"));
          await row.hover();
          expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
          expect((await measure()).width).toBe(hover.width);
          await menuTrigger.evaluate(button => button.setAttribute("data-state", "closed"));
          expect(await text.evaluate(el => el.getAnimations().length)).toBe(1);
          await row.evaluate(el => el.setAttribute("data-state", "open"));
          expect(await text.evaluate(el => el.getAnimations().length)).toBe(0);
          await row.evaluate(el => el.setAttribute("data-state", "closed"));
          expect(await text.evaluate(el => el.getAnimations().length)).toBe(1);
          await text.evaluate(text => { const animation = text.getAnimations()[0]; if (!animation) throw new Error("Missing Project title scroll"); animation.pause(); animation.currentTime = 2000; });
          expect(await text.evaluate(text => new DOMMatrix(getComputedStyle(text).transform).m41)).toBeLessThan(0);
          await text.evaluate(text => text.getAnimations().forEach(animation => animation.cancel()));
          await page.mouse.move(500, 400);
          await row.locator(".work-rail-project-select").focus();
          expect((await measure()).width).toBe(hover.width);
          expect(await text.evaluate(text => text.getAnimations().length)).toBe(1);
          await row.locator(".work-rail-project-disclosure").focus();
          const keyboardTree = await measure();
          expect(keyboardTree.width).toBe(hover.width);
          expect(keyboardTree.disclosureRight - keyboardTree.disclosureLeft).toBe(24);
          expect(keyboardTree.disclosureRight).toBeLessThanOrEqual(keyboardTree.actionLeft);
          await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
          await row.locator(".work-rail-project-actions button").first().evaluate(button => button.setAttribute("data-state", "open"));
          expect((await measure()).width).toBe(hover.width);
          expect(await text.evaluate(text => text.getAnimations().length)).toBe(0);
          await row.locator(".work-rail-project-actions button").first().evaluate(button => button.setAttribute("data-state", "closed"));
          await row.evaluate(row => row.setAttribute("data-state", "open"));
          const context = await measure();
          expect(context.actionOpacity).toBe("1");
          expect(context.width).toBe(hover.width);
          expect(context.disclosureRight).toBeLessThanOrEqual(context.actionLeft);
          expect(await text.evaluate(text => text.getAnimations().length)).toBe(0);
          await row.evaluate(row => row.setAttribute("data-state", "closed"));
          await row.hover(); await page.emulateMedia({ reducedMotion: "reduce" });
          expect(await text.evaluate(text => text.getAnimations().length)).toBe(0);
          expect(await text.evaluate(text => getComputedStyle(text).textOverflow)).toBe("ellipsis");
          await page.emulateMedia({ reducedMotion: "no-preference" });
        }
      }
    }
  } finally { await page.close(); }
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
