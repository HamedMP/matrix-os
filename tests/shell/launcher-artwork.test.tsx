// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTile } from "@/components/AppTile";
import { DockIcon } from "@/components/desktop/DockIcon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MobileDock } from "@/components/mobile/MobileDock";
import { buildWebDesktopLauncherApps, webShellIconUrlForApp, webGalleryLauncherIconUrl } from "@/lib/web-desktop-app-launch";
afterEach(cleanup);
describe("launcher artwork across Web Canvas and Web Mobile", () => {
 it.each([false,true])("keeps Canvas art transparent, including open=%s", isOpen => {
  render(<AppTile name="Notes" isOpen={isOpen} onClick={vi.fn()} iconUrl="/notes.png" />);
  const image=screen.getByRole("img",{name:"Notes"});expect(image.className).toContain("object-contain");
  expect(image.parentElement!.className).toContain("bg-transparent");expect(image.parentElement!.className).not.toContain("bg-card");
 });
 it("keeps the readable initial fallback after artwork fails", () => {
  render(<AppTile name="Notes" isOpen={false} onClick={vi.fn()} />);
  expect(screen.getByRole("button",{name:"Notes"}).querySelector('[data-app-icon]')!.className).toContain("bg-card");
 });
 it("removes the Canvas dock's white art frame", () => {
  render(<TooltipProvider><DockIcon name="Terminal" active={false} onClick={vi.fn()} iconUrl="/terminal.png" /></TooltipProvider>);
  const image=screen.getByRole("img",{name:"Terminal"});expect(image.className).toContain("object-contain");expect(image.closest("button")!.className).toContain("bg-transparent");
 });
 it("fills shell-owned Terminal and Files with current art without replacing owner selections", () => {
  expect(webShellIconUrlForApp({path:"__terminal__"})).toContain("/system-app-icons/v2/terminal.png");
  expect(webShellIconUrlForApp({path:"__file-browser__"})).toContain("/system-app-icons/v2/files.png");
  expect(webShellIconUrlForApp({path:"matrix-app:terminal", iconUrl:"/owner-terminal.png"})).toBe("/owner-terminal.png");
 });
 it.each(["desktop","canvas"] as const)("uses new presentation art when leaving %s", mode => {
  const destination=buildWebDesktopLauncherApps([],mode)[0];expect(destination.iconUrl).toContain(`/system-app-icons/v3/${mode === "desktop" ? "canvas" : "desktop"}.png`);
 });
 it("uses Gallery art in the mobile Apps control and preserves the supplied built-in images", () => {
  const icon=webShellIconUrlForApp({path:"__terminal__"})!;
  render(<MobileDock apps={[{id:"terminal",path:"__terminal__",name:"Terminal",iconSlug:"terminal",iconUrl:icon}]} view="launcher" hidden={false} openCount={0} onOpen={vi.fn()} onShowApps={vi.fn()} onShowSwitcher={vi.fn()} />);
  expect(screen.getByRole("button",{name:"Terminal"}).querySelector("img")?.getAttribute("src")).toBe(icon);
  expect(screen.getByRole("button",{name:"Apps"}).querySelector("img")?.getAttribute("src")).toContain("v3-app-gallery.png");
  expect(webGalleryLauncherIconUrl([{name:"App Gallery",path:"apps/app-gallery/index.html",iconUrl:"/owner-gallery.png"}])).toBe("/owner-gallery.png");
 });
});

describe("support launcher placement", () => {
 const css = readFileSync("shell/src/app/globals.css", "utf8");
 const rule = css.slice(css.indexOf("/* The SDK launcher"));
 const selector = rule.slice(rule.indexOf("body:"), rule.indexOf("{")).trim();
 it("moves only the closed support launcher above a mounted mobile dock", () => {
  const { container } = render(<><main data-testid="mobile-shell" /><div id="ph-conversations-widget-container"><div><button aria-label="Open chat (2 unread)">Support</button></div></div></>);
  expect(document.querySelectorAll(selector)).toHaveLength(1);
  expect(rule).toContain("100px + env(safe-area-inset-bottom");
  container.querySelector("main")!.removeAttribute("data-testid");
  expect(document.querySelectorAll(selector)).toHaveLength(0);
 });
 it("leaves an explicitly opened conversation in its normal placement", () => {
  render(<><main data-testid="mobile-shell" /><div id="ph-conversations-widget-container"><div><button aria-label="Close chat">Close</button></div></div></>);
  expect(document.querySelectorAll(selector)).toHaveLength(0);
 });
});
