import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
import { ChatAgentRailRow } from "../../../packages/ui/src/chat-agents/ChatAgentRailRow.js";
import { ChatRailSection } from "../../../packages/ui/src/chat/ChatRailSection.js";
import { saved } from "../../desktop/chat-agents-fixture";
const {chromium} = createRequire(new URL("../../../shell/package.json",import.meta.url))("@playwright/test");
let browser: Browser;
let css: string;
beforeAll(async()=>{
  css=await readFile(new URL("../../../packages/ui/src/chat-agents/chat-agents.css",import.meta.url),'utf8');
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
});
afterAll(async()=>browser?.close());
it('keeps Agent hover/focus actions safe and Current geometry stable',async()=>{
  const page=await browser.newPage({viewport:{width:500,height:400}});
  try {
    const row=(current:boolean)=>React.createElement(ChatAgentRailRow,{agent:saved,status:{state:'working',label:'Working'},current,opening:false,disabled:false,onOpen:()=>{},menuZIndex:11000});
    const markup=renderToStaticMarkup(React.createElement('main',null,row(false),row(true),React.createElement(ChatRailSection,{label:'Working',count:2,expanded:false,onExpandedChange:()=>{},children:null})));
    await page.setContent(`<style>${css} body{margin:0} main{width:220px} *{box-sizing:border-box} button{font-family:Arial} :root{--matrix-chat-rail-hover:#f3f2f0;--matrix-chat-rail-current:#fffffd;--matrix-chat-rail-current-border:#ebeae6;--matrix-chat-rail-text:#242323;--matrix-chat-rail-muted:#6e6969}</style>${markup}`);
    const items=page.locator('.matrix-chat-agent-rail-item');
    expect(await items.evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height))).toEqual([48,48]);
    const more=items.first().locator('.matrix-chat-agent-rail-more');
    expect(await more.evaluate(el=>({opacity:getComputedStyle(el).opacity,pointer:getComputedStyle(el).pointerEvents}))).toEqual({opacity:'0',pointer:'none'});
    const before=await items.first().locator('.matrix-chat-agent-rail-name').boundingBox();
    await items.first().hover();
    expect(await more.evaluate(el=>({opacity:getComputedStyle(el).opacity,pointer:getComputedStyle(el).pointerEvents}))).toEqual({opacity:'1',pointer:'auto'});
    expect(await items.first().locator('.matrix-chat-agent-rail-name').boundingBox()).toEqual(before);
    await page.mouse.move(400,300);
    await items.first().locator('.matrix-chat-agent-rail-row').focus();
    expect(await more.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
    await more.click({trial:true});
    const current=items.nth(1);
    expect(await current.evaluate(el=>({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderTopColor}))).toEqual({background:'rgb(255, 255, 253)',border:'rgb(235, 234, 230)'});
    const heading=page.getByRole('button',{name:'Working',exact:true});
    expect(await heading.locator('svg').evaluate(el=>getComputedStyle(el).opacity)).toBe('0');
    await heading.focus();
    expect(await heading.locator('svg').evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
    expect(await heading.evaluate(el=>{const title=el.querySelector('span')!.getBoundingClientRect();const arrow=el.querySelector('svg')!.getBoundingClientRect();return arrow.left-title.right;})).toBe(4);
  } finally {await page.close();}
});
