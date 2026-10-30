// @vitest-environment jsdom

import { GettingStartedVisibilityProvider, useGettingStartedAutoOpenSuppression } from "../../packages/ui/src/getting-started-visibility";
import { GetStartedAnswersProvider, GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";
import { GettingStartedAppProvider, type GettingStartedAppPort } from "../../packages/ui/src/getting-started-app/index.js";

// The real hook opens the gateway socket; these tests drive connections through this stand-in.
const connections = vi.hoisted(() => ({
  connectApp: vi.fn(),
  connectingService: null as string | null,
  failedServices: new Set<string>() as ReadonlySet<string>,
  appsUnavailable: false,
  onChanged: null as (() => void) | null,
}));
vi.mock("../../shell/src/components/onboarding/use-getting-started-connections.js", () => ({
  useGettingStartedConnections: (onChanged: () => void) => {
    connections.onChanged = onChanged;
    return connections;
  },
}));
import React from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_DOWNLOAD_URL,
  GETTING_STARTED_REFRESH_MS,
  GettingStartedPopover,
  resolveDesktopDownloadSuggestion,
  loadWebGettingStartedSnapshot,
  webGettingStartedAutoOpenKey,
} from "../../shell/src/components/onboarding/GettingStartedPopover.js";

function render(ui: React.ReactNode) {
  return rtlRender(ui, { wrapper: ({ children }) => <GettingStartedVisibilityProvider scope="test">{children}</GettingStartedVisibilityProvider> });
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function responseFor(url: string): unknown {
  if (url.endsWith("/api/github/status")) {
    return { installed: true, authenticated: false, user: null };
  }
  if (url.endsWith("/api/integrations")) {
    return [
      { id: CONNECTION_ID, service: "github", account_label: "octocat", status: "active" },
      { id: "22222222-2222-4222-8222-222222222222", service: "gmail", account_label: "Mail", status: "active" },
      { id: "33333333-3333-4333-8333-333333333333", service: "google_calendar", account_label: "Calendar", status: "active" },
    ];
  }
  if (url.endsWith("/api/agents/credentials/status")) {
    return { agents: [{ agent: "codex", status: "available" }] };
  }
  if (url.endsWith("/api/workspace/projects")) return { projects: [] };
  if (url.endsWith("/api/chats?limit=1")) return { items: [{ id: "chat_1" }] };
  if (url.includes("/billing/status")) return { access: { runtimeProxyAllowed: true } };
  throw new Error(`Unexpected URL: ${url}`);
}

function installSuccessfulFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    return new Response(JSON.stringify(responseFor(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("web getting started status", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("derives the same five completion checks as Electron", async () => {
    window.history.replaceState({}, "", "/vm/work?runtime=studio");
    const fetcher = installSuccessfulFetch();
    const controller = new AbortController();

    const snapshot = await loadWebGettingStartedSnapshot(fetcher, controller.signal);

    expect(snapshot.steps.map((step) => [step.id, step.status])).toEqual([
      ["github", "complete"],
      ["email-calendar", "complete"],
      ["agent", "complete"],
      ["first-work", "complete"],
      ["billing", "complete"],
    ]);
    expect(snapshot.completedCount).toBe(5);
    // Six checklist reads plus provider settings for the Getting started app's AI task (spec 639).
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/api\/ai\/provider-settings$/), expect.objectContaining({ signal: controller.signal }));
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/github\/status$/),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/billing/status?runtimeSlot=studio",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("suggests a direct platform download without sending users to GitHub", () => {
    expect(resolveDesktopDownloadSuggestion({ platform: "Win32", userAgent: "Windows NT 10.0" })).toEqual({
      href: "https://matrix-os.com/api/desktop-release?platform=windowsX64",
      label: "Download for Windows",
      guidance: "SmartScreen: select More info, verify Finna Labs Inc., then select Run anyway. Run as administrator does not bypass it.",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "Linux x86_64", userAgent: "X11; Linux x86_64" })).toEqual({
      href: "https://matrix-os.com/api/desktop-release?platform=linuxX64",
      label: "Download for Linux",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "MacIntel", userAgent: "Macintosh" }, "arm")).toEqual({
      href: "https://matrix-os.com/api/desktop-release?platform=macArm64",
      label: "Download for macOS (Apple silicon)",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "MacIntel", userAgent: "Macintosh" }, "x86")).toEqual({
      href: "https://matrix-os.com/api/desktop-release?platform=macX64",
      label: "Download for macOS (Intel)",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "MacIntel", userAgent: "Macintosh" })).toEqual({
      href: DESKTOP_APP_DOWNLOAD_URL,
      label: "Choose macOS download",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "Win32", userAgent: "Windows NT 10.0" }, "arm64")).toEqual({
      href: DESKTOP_APP_DOWNLOAD_URL,
      label: "Choose desktop download",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "Linux", userAgent: "X11; Linux" }, "aarch64")).toEqual({
      href: DESKTOP_APP_DOWNLOAD_URL,
      label: "Choose desktop download",
    });
    expect(resolveDesktopDownloadSuggestion({ platform: "Linux", userAgent: "Linux; Android 14; Pixel 8" }, "x86_64")).toEqual({
      href: DESKTOP_APP_DOWNLOAD_URL,
      label: "Choose desktop download",
    });
    expect(DESKTOP_APP_DOWNLOAD_URL).toBe("https://matrix-os.com/desktop");
  });

  it("keeps only the Getting started app row and the desktop download in Help when this computer serves the app", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    installSuccessfulFetch();
    const onOpen = vi.fn();
    const port: GettingStartedAppPort = {
      loadResults: vi.fn(async () => { throw new Error("not needed"); }),
      loadProgress: vi.fn(async () => ({ awards: [], total: 0 })),
      award: vi.fn(async () => ({ awarded: false, points: 0, total: 0 })),
      claimAutoOpen: vi.fn(async () => false),
      desktopIconPlaced: vi.fn(async () => true),
      markDesktopIconPlaced: vi.fn(async () => undefined),
      loadLogos: vi.fn(async () => ({})),
    };
    render(
      <GettingStartedAppProvider port={port} onOpen={onOpen}>
        <GettingStartedPopover onOpenSettings={vi.fn()} onOpenFirstWork={vi.fn()} helpMenu={{ onSupport: vi.fn(), discordIcon: <span /> }} />
      </GettingStartedAppProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    const row = await screen.findByRole("button", { name: /^Getting started — 0 of 12 done/ });
    expect(screen.getByRole("link", { name: /desktop|Download|Mac|Windows|Linux/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Getting started — \d+ of 5/ })).toBeNull();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
  });

  it("opens the Web checklist through the shared nested Help menu", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    installSuccessfulFetch();
    window.localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
    render(<GettingStartedPopover onOpenSettings={vi.fn()} onOpenFirstWork={vi.fn()}
      helpMenu={{ onSupport: vi.fn(), discordIcon: <span /> }} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    const trigger = await screen.findByRole("button", { name: "Getting started — 5 of 5" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Support chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Help", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Help" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Getting started —/ }));
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  });

  it("stays open until its title-bar trigger is clicked and offers the detected desktop download", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows NT 10.0" });
    installSuccessfulFetch();
    window.localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
    const onOpenSettings = vi.fn();
    const onOpenFirstWork = vi.fn();

    render(
      <>
        <button type="button">Outside</button>
        <GettingStartedPopover
          onOpenSettings={onOpenSettings}
          onOpenFirstWork={onOpenFirstWork}
        />
      </>,
    );

    const trigger = await screen.findByRole("button", { name: "Getting started — 5 of 5" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
    expect(screen.getByTestId("getting-started-counter").textContent).toBe("5 of 5");

    const download = screen.getByRole("link", { name: "Download for Windows" });
    expect(download.getAttribute("href")).toBe("https://matrix-os.com/api/desktop-release?platform=windowsX64");
    expect(download.getAttribute("target")).toBe("_blank");
    expect(download.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("SmartScreen: select More info, verify Finna Labs Inc., then select Run anyway. Run as administrator does not bypass it.")).toBeTruthy();
    const dialogActions = screen
      .getByRole("dialog", { name: "Getting started" })
      .querySelectorAll("a, button");
    expect(dialogActions[0]).toBe(download);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();

    // A finished step without a try action still opens its Settings page, and the checklist stays open.
    fireEvent.click(screen.getByRole("button", { name: "Log in to Codex / Claude" }));
    expect(onOpenSettings).toHaveBeenCalledWith("agents-providers");
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());
  });

  it("auto-opens once per web computer scope while setup remains incomplete", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith("/api/integrations") ? []
        : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
          : url.endsWith("/api/workspace/projects") ? { projects: [] }
            : url.endsWith("/api/chats?limit=1") ? { items: [] }
              : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: false } }
                : { authenticated: false };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    render(<GettingStartedPopover onOpenSettings={() => {}} onOpenFirstWork={() => {}} />);

    expect(await screen.findByRole("dialog", { name: "Getting started" })).toBeTruthy();
    expect(window.localStorage.getItem(webGettingStartedAutoOpenKey("/"))).toBe("1");
  });

  describe("closing the loop (customer feedback)", () => {
    function installFetch(integrations: unknown[]) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        const body = url.endsWith("/api/integrations") ? integrations
          : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
            : url.endsWith("/api/workspace/projects") ? { projects: [] }
              : url.endsWith("/api/chats?limit=1") ? { items: [] }
                : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: true } }
                  : { authenticated: false };
        return new Response(JSON.stringify(body), { status: 200 });
      });
    }

    async function openPopover(onOpenFirstWork = vi.fn(), onOpenSettings = vi.fn()) {
      render(<GettingStartedPopover onOpenSettings={onOpenSettings} onOpenFirstWork={onOpenFirstWork} />);
      fireEvent.click(await screen.findByRole("button", { name: /^Getting started — / }));
      return screen.findByRole("dialog", { name: "Getting started" });
    }

    beforeEach(() => {
      vi.stubGlobal("PointerEvent", MouseEvent);
      window.localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
      connections.connectApp.mockReset();
    });

    it("starts GitHub's own sign-in and reloads the moment a connection changes", async () => {
      const fetcher = installFetch([]);
      const onOpenSettings = vi.fn();
      const dialog = await openPopover(vi.fn(), onOpenSettings);
      fireEvent.click(await within(dialog).findByRole("button", { name: "Connect GitHub" }));
      expect(connections.connectApp).toHaveBeenCalledWith("github");
      expect(onOpenSettings).not.toHaveBeenCalled();
      const reads = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith("/api/integrations")).length;
      const before = reads();
      act(() => connections.onChanged?.());
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    });

    it("says when a sign-in did not finish", async () => {
      installFetch([]);
      connections.failedServices = new Set(["github"]);
      try {
        const dialog = await openPopover();
        expect(await within(dialog).findByText("Sign-in didn't finish. Click to try again.")).toBeTruthy();
      } finally {
        connections.failedServices = new Set();
      }
    });

    it("shows email & calendar as half done and connects the missing app", async () => {
      installFetch([{ id: CONNECTION_ID, service: "gmail", status: "active" }]);
      const dialog = await openPopover();
      fireEvent.click(await within(dialog).findByRole("button", { name: /Connect Google Calendar \(1 of 2\)/ }));
      expect(connections.connectApp).toHaveBeenCalledWith("google_calendar");
    });

    it("turns finished email into a ready prompt in a new chat, unsent", async () => {
      installFetch([
        { id: CONNECTION_ID, service: "gmail", status: "active" },
        { id: "22222222-2222-4222-8222-222222222222", service: "google_calendar", status: "active" },
      ]);
      const onOpenFirstWork = vi.fn();
      const dialog = await openPopover(onOpenFirstWork);
      fireEvent.click(await within(dialog).findByRole("button", { name: /Find emails that need a reply/ }));
      expect(onOpenFirstWork).toHaveBeenCalledWith({ kind: "chat", prompt: expect.stringMatching(/still need a reply from me.*Don't send anything\./) });
    });

    it("says the coding agent is signed in on the Matrix computer", async () => {
      installFetch([]);
      const dialog = await openPopover();
      expect(await within(dialog).findByText("On your Matrix computer, where your AI runs")).toBeTruthy();
    });
  });

  describe("after Get started", () => {
    function installIncompleteFetch() {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        const body = url.endsWith("/api/integrations") ? []
          : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
            : url.endsWith("/api/workspace/projects") ? { projects: [] }
              : url.endsWith("/api/chats?limit=1") ? { items: [] }
                : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: false } }
                  : { authenticated: false };
        return new Response(JSON.stringify(body), { status: 200 });
      });
    }

    function ended(state: unknown): GetStartedPort {
      return { load: vi.fn(async () => state), save: vi.fn() };
    }

    function renderAfter(state: unknown) {
      render(
        <GetStartedAnswersProvider scope="test">
          <GetStartedGate port={ended(state)} zIndex={1} />
          <GettingStartedPopover onOpenSettings={() => {}} onOpenFirstWork={() => {}} />
        </GetStartedAnswersProvider>,
      );
    }

    beforeEach(() => {
      vi.stubGlobal("PointerEvent", MouseEvent);
      installIncompleteFetch();
      // Opened on an earlier load already.
      window.localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
    });

    it("reopens on every load until done when setup was skipped", async () => {
      renderAfter({ status: "skipped", skippedAt: "2026-10-22T10:00:00.000Z" });
      expect(await screen.findByRole("dialog", { name: "Getting started" })).toBeTruthy();
    });

    it("adds rows for picked tools and added bots, and opens the right place", async () => {
      vi.restoreAllMocks();
      const BOT_CHAT = "chat_writer0001";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        const body = url.endsWith("/api/chat-agents") ? {
          enabled: true,
          agents: [{ id: "bot_write001", archived: false, createdAt: "2026-10-22T10:00:00.000Z", recipeRef: { recipeId: "writing-bot", version: 1 } }],
        }
          : url.endsWith("/api/chat-agents/bot_write001/direct-chat") ? { chatId: init?.method === "POST" ? BOT_CHAT : null }
          : url.endsWith("/api/settings/get-started/bots") ? { bots: { "writing-bot": { status: "created", agentId: "bot_write001" } } }
            : url.endsWith("/api/integrations") ? []
              : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
                : url.endsWith("/api/workspace/projects") ? { projects: [] }
                  : url.endsWith("/api/chats?limit=1") ? { items: [] }
                    : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: false } }
                      : { authenticated: false };
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const onOpenSettings = vi.fn();
      const onOpenFirstWork = vi.fn();
      render(
        <GetStartedAnswersProvider scope="test">
          <GetStartedGate port={ended({ status: "completed", completedAt: "2026-10-22T10:00:00.000Z", answers: { goals: ["code"], tools: ["codex", "linear"], bots: ["writing-bot"] } })} zIndex={1} />
          <GettingStartedPopover onOpenSettings={onOpenSettings} onOpenFirstWork={onOpenFirstWork} />
        </GetStartedAnswersProvider>,
      );
      const dialog = await screen.findByRole("dialog", { name: "Getting started" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Connect Linear" }));
      expect(connections.connectApp).toHaveBeenCalledWith("linear");
      fireEvent.click(await within(dialog).findByRole("button", { name: "Chat with Writing Bot" }));
      await waitFor(() => expect(onOpenFirstWork).toHaveBeenCalledWith({ kind: "chat", chatId: BOT_CHAT }));
      expect(within(dialog).getByTestId("getting-started-counter").textContent).toBe("0 of 7");
      fireEvent.click(within(dialog).getByTestId("getting-started-app-gallery"));
      expect(onOpenFirstWork).toHaveBeenLastCalledWith({ kind: "app-gallery" });
    });

    it("offers to create a chosen bot whose creation failed, and retries it", async () => {
      vi.restoreAllMocks();
      let created = false;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/settings/get-started/bots") && init?.method === "POST") {
          created = true;
          return new Response(JSON.stringify({ bots: { "writing-bot": "ready" } }), { status: 200 });
        }
        if (url.endsWith("/api/settings/get-started/bots")) {
          return new Response(JSON.stringify({ bots: { "writing-bot": created ? { status: "created", agentId: "bot_write001" } : { status: "pending" } } }), { status: 200 });
        }
        const body = url.endsWith("/api/chat-agents") ? {
          enabled: true,
          agents: created ? [{ id: "bot_write001", archived: false, createdAt: "2026-10-22T10:00:00.000Z", recipeRef: { recipeId: "writing-bot", version: 1 } }] : [],
        }
          : url.endsWith("/api/chat-agents/bot_write001/direct-chat") ? { chatId: null }
            : url.endsWith("/api/integrations") ? []
              : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
                : url.endsWith("/api/workspace/projects") ? { projects: [] }
                  : url.endsWith("/api/chats?limit=1") ? { items: [] }
                    : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: false } }
                      : { authenticated: false };
        return new Response(JSON.stringify(body), { status: 200 });
      });
      render(
        <GetStartedAnswersProvider scope="test">
          <GetStartedGate port={ended({ status: "completed", completedAt: "2026-10-22T10:00:00.000Z", answers: { goals: [], tools: [], bots: ["writing-bot"] } })} zIndex={1} />
          <GettingStartedPopover onOpenSettings={vi.fn()} onOpenFirstWork={vi.fn()} />
        </GetStartedAnswersProvider>,
      );
      const dialog = await screen.findByRole("dialog", { name: "Getting started" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Create Writing Bot" }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/api/settings/get-started/bots") && init?.method === "POST")).toBe(true));
      expect(await within(dialog).findByRole("button", { name: "Chat with Writing Bot" })).toBeTruthy();
    });

    it("leads with the owner's answers and shows an icon on every step", async () => {
      renderAfter({ status: "completed", completedAt: "2026-10-22T10:00:00.000Z", answers: { goals: ["code"], tools: ["codex"] } });
      const dialog = await screen.findByRole("dialog", { name: "Getting started" });
      const rows = await waitFor(() => {
        const buttons = within(dialog).getAllByRole("button").filter((button) => button.dataset.testid !== "getting-started-app-gallery");
        expect(buttons[0].textContent).toContain("Log in to Codex");
        return buttons;
      });
      expect(rows).toHaveLength(5);
      for (const row of rows) expect(row.querySelector("svg")).not.toBeNull();
      expect(within(dialog).getByTestId("getting-started-app-gallery").textContent).toContain("Build your first app in App Gallery");
    });
  });

  it("stays closed while the onboarding widget is showing, but still opens from its button", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith("/api/integrations") ? []
        : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
          : url.endsWith("/api/workspace/projects") ? { projects: [] }
            : url.endsWith("/api/chats?limit=1") ? { items: [] }
              : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: false } }
                : { authenticated: false };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    function WidgetShowing() {
      useGettingStartedAutoOpenSuppression();
      return null;
    }

    render(<><WidgetShowing /><GettingStartedPopover onOpenSettings={() => {}} onOpenFirstWork={() => {}} /></>);
    const trigger = await screen.findByRole("button", { name: "Getting started — 0 of 5" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    expect(window.localStorage.getItem(webGettingStartedAutoOpenKey("/"))).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
  });

  it("refreshes completion while the persistent popover remains open", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("PointerEvent", MouseEvent);
    window.localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
    let completed = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith("/api/integrations")
        ? (completed ? [
          { id: CONNECTION_ID, service: "github", status: "active" },
          { id: "22222222-2222-4222-8222-222222222222", service: "gmail", status: "active" },
          { id: "33333333-3333-4333-8333-333333333333", service: "google_calendar", status: "active" },
        ] : [])
        : url.endsWith("/api/agents/credentials/status") ? { agents: completed ? [{ agent: "codex", status: "available" }] : [] }
          : url.endsWith("/api/workspace/projects") ? { projects: completed ? [{}] : [] }
            : url.endsWith("/api/chats?limit=1") ? { items: [] }
              : url.includes("/billing/status") ? { access: { runtimeProxyAllowed: completed } }
                : { authenticated: completed };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    render(<GettingStartedPopover onOpenSettings={() => {}} onOpenFirstWork={() => {}} />);
    await act(async () => Promise.resolve());
    const trigger = screen.getByRole("button", { name: "Getting started — 0 of 5" });
    fireEvent.click(trigger);
    completed = true;

    await act(async () => {
      vi.advanceTimersByTime(GETTING_STARTED_REFRESH_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("getting-started-counter").textContent).toBe("5 of 5");
    vi.useRealTimers();
  });
});
