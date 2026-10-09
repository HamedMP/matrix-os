import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { ProjectLanding } from "../../desktop/src/renderer/src/features/project/ProjectLanding";
import { CanonicalNewChatContent } from "../../desktop/src/renderer/src/features/chat/CanonicalNewChatContent";
import { SharedChatSurface } from "../../desktop/src/renderer/src/features/chat/SharedChatSurface";

const fixture = vi.hoisted(() => ({ onboarding: false }));
vi.mock("../../desktop/src/renderer/src/features/project/use-project-landing-chats", () => ({
  useProjectLandingChats: () => ({ chats: [], error: false }),
}));
vi.mock("../../desktop/src/renderer/src/features/work/work-rail/use-project-actions", () => ({
  useProjectActions: () => ({ available: true, pending: false, error: null, dialog: null }),
}));
vi.mock("../../desktop/src/renderer/src/features/chat/ChatProviderOnboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: ReactNode }) => fixture.onboarding
    ? React.createElement("div", { style: { height: 500 } }, React.createElement("button", { type: "button" }, "Connect provider"))
    : children,
}));

const root = resolve(__dirname, "../..");
const { chromium } = createRequire(resolve(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");

describe("Project detail and composer geometry in the actual browser layout engine", () => {
  let browser: Browser;
  let css: string;
  beforeAll(async () => {
    const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
    css = tailwind.build(new Scanner({ sources: [
      { base: resolve(root, "desktop/src/renderer/src/features/project"), pattern: "ProjectLanding.tsx", negated: false },
      { base: resolve(root, "desktop/src/renderer/src/features/chat"), pattern: "CanonicalNewChatContent.tsx", negated: false },
      { base: __dirname, pattern: "project-landing-layout.e2e.test.ts", negated: false },
    ] }).scan());
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });

  it.each([
    { width: 900, height: 900, onboarding: false, composerHeight: 120 },
    { width: 900, height: 420, onboarding: false, composerHeight: 120 },
    { width: 340, height: 420, onboarding: false, composerHeight: 120 },
    { width: 340, height: 260, onboarding: false, composerHeight: 120 },
    { width: 340, height: 420, onboarding: false, composerHeight: 220 },
    { width: 340, height: 420, onboarding: true, composerHeight: 120 },
  ])("fills the space above the composer at $width x $height, onboarding=$onboarding, composer=$composerHeight", async ({ width, height, onboarding, composerHeight }) => {
    fixture.onboarding = onboarding;
    const records = Array.from({ length: 30 }, (_, index) => ({
      chat: { id: `chat_${index}`, title: `Plan ${index}`, attention: "none" }, projectId: "alpha",
    } as CanonicalChatRecord));
    // The same flex chain as the external-navigation canonical Project route;
    // the shared surface and both landing components are actual components.
    const html = renderToStaticMarkup(React.createElement("div", { id: "panel", style: { width, height } },
      React.createElement(ProjectLanding, {
        project: { id: "alpha", slug: "alpha", name: "Alpha", kind: "folder" }, records, onSelectChat: () => {},
        children: React.createElement("div", { className: "relative flex min-h-0 min-w-0 flex-1 overflow-hidden flex-row" },
          React.createElement(SharedChatSurface, {
            ariaLabel: "Project Chat", className: "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            children: React.createElement(CanonicalNewChatContent, {
              projectId: "alpha", workspaceLayout: "wide", onSelect: () => {},
              composer: React.createElement("textarea", { "aria-label": "Project draft", defaultValue: "Unsaved draft", style: { display: "block", width: "100%", height: composerHeight } }),
            }),
          })),
      })));
    const page = await browser.newPage({ viewport: { width: width + 40, height: height + 40 } });
    try {
      await page.setContent(`<!doctype html><style>${css}body{margin:0;font:14px Arial}</style>${html}`);
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>("#panel")!;
        const metadata = panel.querySelector<HTMLElement>("header")!;
        const composer = panel.querySelector<HTMLTextAreaElement>("textarea")!;
        const onboarding = panel.querySelector<HTMLElement>('[data-slot="chat-project-draft-scroll"]')!;
        const p = panel.getBoundingClientRect(), m = metadata.getBoundingClientRect(), c = composer.getBoundingClientRect(), o = onboarding.getBoundingClientRect();
        metadata.scrollTop = metadata.scrollHeight;
        const lastCard = metadata.querySelector<HTMLElement>('[aria-label="Open Plan 29"]')!.getBoundingClientRect();
        return { gap: c.top - m.bottom, metadataHeight: m.height, panelHeight: p.height,
          composerBottom: c.bottom, panelBottom: p.bottom, composerHeight: c.height,
          composerWidth: c.width, composerLeft: c.left, composerValue: composer.value,
          onboardingHeight: o.height, onboardingOverflow: onboarding.scrollHeight > onboarding.clientHeight,
          metadataOverflow: metadata.scrollHeight > metadata.clientHeight,
          lastCardBottom: lastCard.bottom, metadataBottom: m.bottom };
      });
      expect(geometry.composerHeight).toBe(composerHeight);
      expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.panelBottom);
      expect(geometry.composerBottom).toBeCloseTo(geometry.panelBottom - 20, 0);
      expect(geometry.composerWidth).toBeCloseTo(Math.min(width, 768) - 48, 0);
      expect(geometry.composerValue).toBe("Unsaved draft");
      expect(geometry.metadataOverflow).toBe(true);
      expect(geometry.lastCardBottom).toBeLessThanOrEqual(geometry.metadataBottom + 1);
      if (onboarding) {
        expect(geometry.onboardingOverflow).toBe(true);
        expect(geometry.onboardingHeight).toBeGreaterThan(0);
      } else {
        expect(geometry.gap).toBeLessThanOrEqual(12);
        expect(geometry.metadataHeight).toBeCloseTo(geometry.panelHeight - composerHeight - 20, 0);
      }
    } finally { await page.close(); }
  });
});
