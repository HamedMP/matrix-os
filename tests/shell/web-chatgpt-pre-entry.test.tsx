// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatProviderOnboarding } from "../../shell/src/components/chat-provider-onboarding";
import { OPEN_PROVIDER_SETTINGS_EVENT } from "../../shell/src/lib/canonical-provider-setup";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

// Both browser presentations mount this same onboarding adapter. These are
// component/transport fixtures, not live Desktop or Canvas visual evidence.
it.each(["desktop", "canvas"] as const)(
  "Web %s discloses Electron subscription management before the Settings handoff",
  async (presentation) => {
    window.history.replaceState({}, "", `/?presentation=${presentation}`);
    const mutations = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") mutations();
      return Response.json(disconnectedSnapshot());
    }));
    const settings = vi.fn();
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, settings);
    try {
      render(<ChatProviderOnboarding><textarea aria-label="Chat draft" defaultValue="Keep my prompt" /></ChatProviderOnboarding>);
      const connect = await screen.findByRole("button", { name: "Connect Codex" });
      const entry = screen.getByRole("region", { name: "Chat provider connection" });
      // Require the limitation at the actual entry, not only in Settings.
      expect(within(entry).getByText("ChatGPT subscription management requires Electron Desktop on the owner’s device.")).toBeVisible();
      expect(within(entry).getByText("The paired device must stay connected while chats and Matrix Bots run.")).toBeVisible();
      fireEvent.click(connect);
      expect(settings).toHaveBeenCalledOnce();
      expect(mutations).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, settings);
    }
  },
);
