// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";

vi.mock("@clerk/nextjs", async importOriginal => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(createCanonicalProviderCatalogFixture())));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("lets the Web Chat sidebar list shrink below its content so it scrolls", () => {
  render(<ChatApp messages={[]} busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} />);
  const sidebar = screen.getByRole("textbox", { name: "Search chats" }).closest("aside")!;
  const list = sidebar.querySelector("[data-slot=scroll-area]")!;
  // A flex-1 child keeps min-height:auto and grows to fit every row unless it may shrink.
  expect(list.className.split(/\s+/)).toContain("min-h-0");
});
