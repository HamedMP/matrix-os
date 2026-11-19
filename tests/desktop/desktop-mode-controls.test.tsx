// @vitest-environment jsdom

import React from "react";
import { GettingStartedVisibilityProvider } from "@matrix-os/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopModeControls from "@desktop/renderer/src/features/desktop-shell/DesktopModeControls";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDesktopUpdate } from "@desktop/renderer/src/stores/desktop-update";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({
  default: () => <button type="button">Main computer</button>,
}));

describe("Desktop mode controls", () => {
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ handle: "neo", displayName: "Neo", imageUrl: null });
    useDesktopUpdate.setState({
      snapshot: { status: "ready", version: "1.2.3", progress: 100 },
      installing: false,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    localStorage.clear();
    localStorage.setItem("matrix:getting-started:auto-opened:neo:primary", "1");
    vi.stubGlobal("PointerEvent", MouseEvent);
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeApi(incomplete: boolean) {
    const responses: Record<string, unknown> = {
      "/api/github/status": { installed: true, authenticated: true, user: "octocat", gitProtocol: "ssh", sshStatus: "verified", commitIdentity: { status: "ready", label: "Octocat" }, ready: true, errorCode: null },
      "/api/integrations": incomplete ? [] : [
        { id: "11111111-1111-4111-8111-111111111111", service: "gmail", account_label: "Mail", status: "active" },
        { id: "22222222-2222-4222-8222-222222222222", service: "google_calendar", account_label: "Calendar", status: "active" },
      ],
      "/api/agents/credentials/status": { agents: [{ agent: "codex", status: "available" }] },
      "/api/workspace/projects": { projects: [] },
      "/api/chats?limit=1": { items: [{ chat: { id: "chat_1" } }] },
      "/billing/status": { entitlement: {}, access: { runtimeProxyAllowed: true } },
    };
    const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(async (path: string) => responses[path] ?? []), post: vi.fn(async () => ({})), forRuntime: vi.fn() };
    api.forRuntime.mockImplementation(() => api);
    return api;
  }
  function renderControls() {
    return render(<GettingStartedVisibilityProvider scope="controls-test"><DesktopModeControls /></GettingStartedVisibilityProvider>);
  }
  function labels() {
    return screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
  }

  it("leads with the Setup pill, drops Help and keeps Update beside the same-size avatar", async () => {
    useConnection.setState({ status: "signed-in", runtimeSlot: "primary", api: makeApi(true) as never });
    renderControls();
    await screen.findByRole("button", { name: "Getting started — 4 of 5" });
    expect(labels()).toEqual([
      "Getting started — 4 of 5",
      "Search",
      "Terminal window",
      "Inbox",
      "Support",
      "Main computer",
      "Update Matrix OS to 1.2.3",
      "Open account menu",
    ]);
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();

    const update = screen.getByRole("button", { name: "Update Matrix OS to 1.2.3" });
    const avatar = screen.getByRole("button", { name: "Open account menu" }).querySelector("span");
    expect(update.className).toContain("size-6");
    expect(avatar?.className).toContain("size-6");
  });

  it("hides the Setup pill and account row once setup is complete", async () => {
    const api = makeApi(false);
    useConnection.setState({ status: "signed-in", runtimeSlot: "primary", api: api as never });
    renderControls();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/billing/status", expect.anything()));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("button", { name: /Getting started —/ })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Open account menu" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menuitem", { name: "Log out" });
    expect(screen.queryByRole("menuitem", { name: /Getting started/ })).toBeNull();
  });

  it("toggles the checklist from the pill and opens it from the account menu", async () => {
    useConnection.setState({ status: "signed-in", runtimeSlot: "primary", api: makeApi(true) as never });
    renderControls();
    const pill = await screen.findByRole("button", { name: "Getting started — 4 of 5" });
    fireEvent.click(pill);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    fireEvent.click(pill);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open account menu" }), { button: 0, ctrlKey: false });
    expect(useUi.getState().rendererOverlayCount).toBeGreaterThan(0);
    const row = await screen.findByRole("menuitem", { name: /Getting started/ });
    expect(row.textContent).toContain("4 of 5");
    expect(row.textContent).toContain("Next: Connect email & calendar");
    expect(screen.getByRole("menuitem", { name: /Join Discord/ }).getAttribute("href")).toBe("https://discord.gg/WHbvTG33w");
    fireEvent.click(row);
    expect(await screen.findByRole("dialog", { name: "Getting started" })).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull());
  });

  it("offers What's New in the account menu with an unseen-release dot", async () => {
    const openWhatsNew = vi.fn();
    useDesktopUpdate.setState({ openWhatsNew, whatsNewUnseen: true });
    renderControls();
    const trigger = screen.getByRole("button", { name: "Open account menu" });
    expect(trigger.querySelector("[data-testid='account-unseen-dot']")).not.toBeNull();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const whatsNew = await screen.findByRole("menuitem", { name: /What's New/ });
    expect(whatsNew.querySelector("[data-testid='whats-new-unseen-dot']")).not.toBeNull();
    fireEvent.click(whatsNew);
    expect(openWhatsNew).toHaveBeenCalledOnce();
  });
});
