import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { build } from "esbuild";
import type { Browser, Locator, Page } from "playwright";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { WebChatLifecycleGroups } from "../../../shell/src/components/chat/WebChatLifecycleGroups.js";
import { RenameableConversationRow, type RenameableConversation } from "../../../shell/src/components/chat/ChatTitleRename.js";
import { buildWorkRailModel } from "../../../desktop/src/renderer/src/features/work/work-rail-model.js";
import { WorkRailGroups } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailGroups.js";
import { WorkRailChatRow } from "../../../desktop/src/renderer/src/features/work/work-rail/WorkRailChatRow.js";

const { chromium } = createRequire(new URL("../../../shell/package.json", import.meta.url))("@playwright/test");
const longTitle = "Investigate why this agent keeps failing while updating the complete quarterly report and its supporting charts";

async function mountOverflowingTitle(page: Page, title: string) {
  const bundle = await build({
    stdin: {
      contents: `import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { OverflowingChatTitle } from "./packages/ui/src/chat/OverflowingChatTitle.tsx";
const host = document.querySelector('[data-chat-title-row][data-current="true"] .matrix-web-chat-title');
createRoot(host).render(createElement(Fragment, null,
  createElement(OverflowingChatTitle, { title: ${JSON.stringify(title)} }),
  createElement("span", { className: "text-[11px] font-normal leading-[14px]" }, "Agent failed")));`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      sourcefile: "mount-overflowing-chat-title.ts",
      loader: "ts",
    },
    bundle: true, platform: "browser", format: "iife", write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.waitForFunction(() => document.querySelector('[data-chat-title-row][data-current="true"] .matrix-chat-title-viewport')?.getAttribute("data-overflowing") === "true");
  await page.addStyleTag({ content: ".matrix-chat-title-text{animation-duration:300ms!important}" });
}

async function expectHoverScroll(page: Page, row: Locator) {
  const viewport = row.locator(".matrix-chat-title-viewport");
  expect(await viewport.getAttribute("data-overflowing")).toBe("true");
  await row.hover();
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-chat-title-row][data-current="true"] .matrix-chat-title-text');
    if (!text) return false;
    const transform = getComputedStyle(text).transform;
    return transform !== "none" && new DOMMatrixReadOnly(transform).m41 < -1;
  }, undefined, { timeout: 2_000 });
  await page.mouse.move(0, 0);
}

function conversation(id: string, title: string, attention: CanonicalChatRecord["chat"]["attention"]): RenameableConversation {
  return {
    id, title, preview: title, messageCount: 1, updatedAt: 1,
    canonicalRecord: {
      chat: {
        id, title, attention, lifecycle: "active", revision: 1, messageCount: 1,
        ownerScope: { type: "personal", ownerId: "fixture" },
        userState: { pinned: false, muted: false, readThroughSeq: 0 },
        createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
      },
    } as CanonicalChatRecord,
  };
}

it("keeps long failed Web Desktop chat titles inside the rail and shows failure separately", async () => {
  const rows = [conversation("input", "Approve the launch plan", "input_required"), conversation("failed", longTitle, "failed"), conversation("done", "Review project notes", "none")];
  const markup = renderToStaticMarkup(React.createElement(WebChatLifecycleGroups, {
    conversations: rows,
    renderRow: (item: RenameableConversation) => React.createElement(RenameableConversationRow, {
      conversation: item, active: item.id === "failed", mobile: false, editing: false, renamePending: false,
      onSelect: () => {}, onRenameCommit: () => {}, onRenameCancel: () => {},
    }),
  }));
  const [railCss, titleCss] = await Promise.all([
    readFile(new URL("../../../packages/ui/src/chat-agents/chat-agents.css", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/ui/src/chat/overflowing-chat-title.css", import.meta.url), "utf8"),
  ]);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 460, height: 440 }, deviceScaleFactor: 2 });
    await page.setContent(`<style>${railCss}\n${titleCss}\n*{box-sizing:border-box}body{margin:0;background:#f8f8f7;color:#242323;font:13px Arial,sans-serif}main{width:280px;padding:20px 10px;background:#fff;min-height:440px;border-right:1px solid #e9e8e4}.matrix-web-chat-row{display:flex;width:100%;align-items:center;gap:8px;text-align:left;border:0;border-radius:8px;cursor:pointer}.matrix-web-chat-title{display:flex;min-width:0;flex:1;flex-direction:column}.matrix-web-chat-title.items-start{align-items:flex-start}.matrix-web-chat-title span[class*="text-\\[11px\\]"]{color:#9f3f2c;font-size:11px;line-height:14px}.matrix-web-chat-row-item[data-current="true"]{background:#f6f4ef}:root{--matrix-chat-rail-muted:#777;--matrix-chat-rail-warning:#d89b29;--danger:#9f3f2c;--text-on-danger:#fff;--matrix-chat-rail-current-border:#e7e3db}</style><main aria-label="Web Desktop chat rail"><div style="padding:6px 10px 16px;font-size:15px;font-weight:600">Chats</div>${markup}</main>`);
    await mountOverflowingTitle(page, longTitle);
    const failedSection = page.getByRole("region", { name: "Failed" });
    const failedRow = failedSection.getByRole("button", { name: `${longTitle}, agent failed` });
    expect(await failedRow.count()).toBe(1);
    expect(await page.getByRole("region", { name: "Needs you" }).getByRole("button", { name: `${longTitle}, agent failed` }).count()).toBe(0);
    const widths = await failedRow.evaluate((row) => {
      const viewport = row.querySelector(".matrix-chat-title-viewport")!;
      const text = row.querySelector(".matrix-chat-title-text")!;
      return { viewportRight: viewport.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right, viewportWidth: viewport.clientWidth, textWidth: text.scrollWidth };
    });
    expect(widths.viewportRight).toBeLessThanOrEqual(widths.rowRight);
    expect(widths.textWidth).toBeGreaterThan(widths.viewportWidth);
    await expectHoverScroll(page, failedRow);
    if (process.env.PR_EVIDENCE_DIR) {
      await mkdir(process.env.PR_EVIDENCE_DIR, { recursive: true });
      await page.locator("main").screenshot({ path: join(process.env.PR_EVIDENCE_DIR, "web-desktop-failed-chat.png") });
    }
    await page.setViewportSize({ width: 300, height: 440 });
    await page.locator("main").evaluate((element) => { (element as HTMLElement).style.width = "250px"; });
    const narrow = await failedRow.evaluate((row) => {
      const viewport = row.querySelector(".matrix-chat-title-viewport")!;
      return { viewportRight: viewport.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right };
    });
    expect(narrow.viewportRight).toBeLessThanOrEqual(narrow.rowRight);
    await expectHoverScroll(page, failedRow);
    if (process.env.PR_EVIDENCE_DIR) {
      await page.locator("main").screenshot({ path: join(process.env.PR_EVIDENCE_DIR, "web-desktop-failed-chat-narrow.png") });
    }
  } finally {
    await browser?.close();
  }
});

it("shows failed Electron Desktop chats in their own section", async () => {
  const records = [
    conversation("input", "Approve the launch plan", "input_required").canonicalRecord!,
    conversation("failed", "Why this agent keeps failing", "failed").canonicalRecord!,
    conversation("done", "Review project notes", "none").canonicalRecord!,
  ];
  const markup = renderToStaticMarkup(React.createElement(WorkRailGroups, {
    model: buildWorkRailModel(records, []),
    sections: { pinned: true, projects: true, needsYou: true, failed: true, working: true, done: true },
    onToggle: () => {}, onCreateProject: () => {}, renderProject: () => null,
    renderChat: (record, placement) => React.createElement(WorkRailChatRow, {
      key: record.chat.id, record, active: record.chat.id === "failed", fresh: true, pinning: false,
      placement, onSelect: () => {}, renaming: false, renamePending: false, renameDisabled: false,
      onRenameStart: () => {}, onRenameCommit: () => {}, onRenameCancel: () => {},
      onPin: () => {}, onDelete: () => {},
    }),
    bots: [], organizationDrives: null, sharedProjects: [],
  }));
  const [railCss, titleCss] = await Promise.all([
    readFile(new URL("../../../desktop/src/renderer/src/features/work/work-rail/work-rail.css", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/ui/src/chat/overflowing-chat-title.css", import.meta.url), "utf8"),
  ]);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 360, height: 420 }, deviceScaleFactor: 2 });
    await page.setContent(`<style>${railCss}\n${titleCss}\n*{box-sizing:border-box}body{margin:0;background:#f8f8f7;color:#242323;font:13px Arial,sans-serif}main{width:292px;padding:20px 10px;background:#fff;min-height:420px;border-right:1px solid #e9e8e4}.work-rail-section{width:100%}.work-rail-section-heading{display:flex;align-items:center}.work-rail-section-toggle{display:flex;align-items:center;width:100%;border:0;background:transparent;cursor:pointer}.work-rail-section-toggle>span:first-child{flex:1}.work-rail-chat button{display:flex;width:100%;align-items:center;gap:8px;border:0;background:transparent;text-align:left}.work-rail-chat-label{display:block;min-width:0;flex:1}.work-rail-chat-label>span{display:block;min-width:0}.work-rail-chat-label .matrix-chat-title-viewport{width:100%}.work-rail-chat[data-current="true"]{background:#f6f4ef;border-radius:8px}:root{--matrix-chat-rail-warning:#d89b29;--matrix-chat-rail-muted:#777;--matrix-chat-rail-text:#242323;--matrix-chat-rail-success:#4d8050;--danger:#9f3f2c;--danger-text:#9f3f2c;--text-on-danger:#fff;--text-tertiary:#777}</style><main aria-label="Electron Desktop chat rail"><div style="padding:6px 10px 16px;font-size:15px;font-weight:600">Chats</div>${markup}</main>`);
    await page.addStyleTag({ content: `.work-rail-section-toggle,.work-rail-section-toggle>span:first-child{text-align:left}.work-rail-chat-actions{display:none!important}.work-rail-chat[data-current="true"]{border:1px solid #e7e3db!important;box-shadow:0 1px 2px rgba(50,53,46,.04)}.work-rail-section-heading{align-items:flex-start}.work-rail-section-toggle{justify-content:flex-start}.work-rail-chat>button{padding:5px 9px}` });
    const failedSection = page.getByRole("button", { name: "Failed", exact: true }).locator("xpath=ancestor::section[1]");
    expect(await failedSection.getByRole("button", { name: "Why this agent keeps failing", exact: true }).count()).toBe(1);
    expect(await failedSection.getByText("Agent failed").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Needs you", exact: true }).locator("xpath=ancestor::section[1]").getByRole("button", { name: "Why this agent keeps failing", exact: true }).count()).toBe(0);
    if (process.env.PR_EVIDENCE_DIR) {
      await mkdir(process.env.PR_EVIDENCE_DIR, { recursive: true });
      await page.locator("main").screenshot({ path: join(process.env.PR_EVIDENCE_DIR, "electron-desktop-failed-chat.png") });
    }
  } finally {
    await browser?.close();
  }
});
