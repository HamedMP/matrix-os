// @vitest-environment jsdom

import { GettingStartedVisibilityProvider, useGettingStartedAutoOpenSuppression } from "../../packages/ui/src/getting-started-visibility";
import { GetStartedAnswersProvider, GetStartedGate, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";
import { GettingStartedAppProvider, type GettingStartedAppPort } from "../../packages/ui/src/getting-started-app/index.js";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GettingStartedPopover, {
  gettingStartedAutoOpenKey,
} from "@desktop/renderer/src/features/onboarding/GettingStartedPopover";
import {
  GETTING_STARTED_STEP_IDS,
  loadGettingStartedSnapshot,
} from "@desktop/renderer/src/features/onboarding/getting-started";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useIntegrations } from "@desktop/renderer/src/features/integrations/integrations-store";
import { useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
import { desktopComposerDraftIdentity, seedNewChatDraft } from "@desktop/renderer/src/features/chat/use-chat-composer-drafts";

function render(ui: React.ReactNode) {
  return rtlRender(ui, { wrapper: ({ children }) => <GettingStartedVisibilityProvider scope="test">{children}</GettingStartedVisibilityProvider> });
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function successfulResponse(path: string): unknown {
  switch (path) {
    case "/api/github/status":
      return { installed: true, authenticated: true, user: "octocat", errorCode: null };
    case "/api/integrations":
      return [
        { id: CONNECTION_ID, service: "gmail", account_label: "Mail", status: "active" },
        { id: "22222222-2222-4222-8222-222222222222", service: "google_calendar", account_label: "Calendar", status: "active" },
      ];
    case "/api/agents/credentials/status":
      return { agents: [{ agent: "codex", status: "available" }] };
    case "/api/workspace/projects":
      return { projects: [] };
    case "/api/chats?limit=1":
      return { items: [{ chat: { id: "chat_1" } }] };
    case "/billing/status":
      return { entitlement: {}, access: { runtimeProxyAllowed: true } };
    default:
      throw new Error(`Unexpected path: ${path}`);
  }
}

function makeApi(overrides: Partial<Record<string, unknown | Error>> = {}) {
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      const override = overrides[path];
      if (override instanceof Error) throw override;
      return override ?? successfulResponse(path);
    }),
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
    forRuntime: vi.fn(),
  };
  api.forRuntime.mockImplementation(() => api);
  return api;
}

describe("getting started status", () => {
  it("derives the five supported steps from canonical runtime state", async () => {
    const api = makeApi();
    const controller = new AbortController();

    const snapshot = await loadGettingStartedSnapshot(api as never, controller.signal);

    expect(GETTING_STARTED_STEP_IDS).toEqual([
      "github",
      "email-calendar",
      "agent",
      "first-work",
      "billing",
    ]);
    expect(snapshot.steps.map((step) => [step.id, step.status])).toEqual([
      ["github", "complete"],
      ["email-calendar", "complete"],
      ["agent", "complete"],
      ["first-work", "complete"],
      ["billing", "complete"],
    ]);
    expect(snapshot.completedCount).toBe(5);
    // Six checklist reads plus provider settings for the Getting started app's AI task (spec 639).
    expect(api.get).toHaveBeenCalledTimes(7);
    expect(api.get).toHaveBeenCalledWith("/api/ai/provider-settings", { signal: controller.signal });
    expect(api.get).toHaveBeenCalledWith("/api/github/status", { signal: controller.signal });
  });

  it("keeps unavailable checks distinct from incomplete steps", async () => {
    const snapshot = await loadGettingStartedSnapshot(makeApi({
      "/api/github/status": new Error("offline"),
      "/api/integrations": [],
      "/api/agents/credentials/status": { agents: [] },
      "/api/workspace/projects": { projects: [] },
      "/api/chats?limit=1": { items: [] },
      "/billing/status": { access: { runtimeProxyAllowed: false } },
    }) as never);

    expect(snapshot.steps.map((step) => step.status)).toEqual([
      "unavailable",
      "incomplete",
      "incomplete",
      "incomplete",
      "incomplete",
    ]);
    expect(snapshot.completedCount).toBe(0);
  });

  it("marks GitHub complete when it is connected through Services", async () => {
    const snapshot = await loadGettingStartedSnapshot(makeApi({
      "/api/github/status": { installed: true, authenticated: false, user: null, errorCode: null },
      "/api/integrations": [
        { id: CONNECTION_ID, service: "github", account_label: "octocat", status: "active" },
      ],
    }) as never);

    expect(snapshot.steps.find((step) => step.id === "github")?.status).toBe("complete");
  });

  it("loads platform-owned billing status through the primary route", async () => {
    const api = makeApi();
    const platformGet = vi.fn(async (path: string) => successfulResponse(path));
    api.forRuntime.mockReturnValue({ ...api, get: platformGet });

    await loadGettingStartedSnapshot(api as never);

    expect(api.forRuntime).toHaveBeenCalledWith("primary");
    expect(platformGet).toHaveBeenCalledWith("/billing/status", undefined);
    expect(api.get).not.toHaveBeenCalledWith("/billing/status", undefined);
  });
});

describe("GettingStartedPopover", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    localStorage.clear();
    useConnection.setState(useConnection.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    useConnection.setState({
      status: "signed-in",
      handle: "neo",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      authGeneration: 4,
      api: makeApi({
        "/api/integrations": [],
        "/api/workspace/projects": { projects: [] },
        "/api/chats?limit=1": { items: [] },
      }) as never,
    });
    localStorage.setItem(gettingStartedAutoOpenKey("neo", "primary"), "1");
  });

  afterEach(async () => {
    cleanup();
    // Radix defers unmount autofocus to a zero-delay timer. Drain that callback
    // while its container and CustomEvent still belong to this jsdom realm.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("auto-opens once while setup is incomplete", async () => {
    localStorage.removeItem(gettingStartedAutoOpenKey("neo", "primary"));
    render(<GettingStartedPopover />);
    expect(await screen.findByRole("dialog", { name: "Getting started" })).not.toBeNull();
    expect(localStorage.getItem(gettingStartedAutoOpenKey("neo", "primary"))).toBe("1");
  });

  describe("closing the loop (customer feedback)", () => {
    async function openWith(overrides: Record<string, unknown>) {
      const api = makeApi({
        "/api/integrations": [],
        "/api/workspace/projects": { projects: [] },
        "/api/chats?limit=1": { items: [] },
        "/api/github/status": { authenticated: false },
        ...overrides,
      });
      useConnection.setState({ api: api as never, userId: "user_1" } as never);
      render(<GettingStartedPopover />);
      fireEvent.click(await screen.findByRole("button", { name: /^Getting started — / }));
      return { api, dialog: await screen.findByRole("dialog", { name: "Getting started" }) };
    }

    it("reloads while open when the window comes back into focus", async () => {
      const { api } = await openWith({});
      const reads = () => api.get.mock.calls.filter(([path]) => path === "/api/integrations").length;
      await waitFor(() => expect(reads()).toBeGreaterThan(0));
      const before = reads();
      fireEvent.focus(window);
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    });

    it("starts GitHub's own sign-in instead of opening the app directory", async () => {
      const startConnect = vi.spyOn(useIntegrations.getState(), "startConnect").mockResolvedValue(null);
      const { dialog } = await openWith({});
      fireEvent.click(await within(dialog).findByRole("button", { name: "Connect GitHub" }));
      await waitFor(() => expect(startConnect).toHaveBeenCalledWith("github", expect.anything()));
      expect(useTabs.getState().tabs.some((tab) => tab.kind === "settings")).toBe(false);
    });

    it("says when a sign-in did not finish", async () => {
      vi.spyOn(useIntegrations.getState(), "startConnect").mockResolvedValue(null);
      const { dialog } = await openWith({});
      fireEvent.click(await within(dialog).findByRole("button", { name: "Connect GitHub" }));
      expect(await within(dialog).findByText("Sign-in didn't finish. Click to try again.")).not.toBeNull();
    });

    it("shows email & calendar as half done and connects the missing app", async () => {
      const startConnect = vi.spyOn(useIntegrations.getState(), "startConnect").mockResolvedValue(null);
      const { dialog } = await openWith({ "/api/integrations": [{ id: CONNECTION_ID, service: "gmail", status: "active" }] });
      fireEvent.click(await within(dialog).findByRole("button", { name: /Connect Google Calendar \(1 of 2\)/ }));
      await waitFor(() => expect(startConnect).toHaveBeenCalledWith("google_calendar", expect.anything()));
    });

    it("says the coding agent is signed in on the Matrix computer", async () => {
      const { dialog } = await openWith({ "/api/agents/credentials/status": { agents: [] } });
      expect(await within(dialog).findByText("On your Matrix computer, where your AI runs")).not.toBeNull();
    });

    it("turns finished email into a ready prompt in a new chat, unsent", async () => {
      const { dialog } = await openWith({
        "/api/integrations": [
          { id: CONNECTION_ID, service: "gmail", status: "active" },
          { id: "22222222-2222-4222-8222-222222222222", service: "google_calendar", status: "active" },
        ],
      });
      fireEvent.click(await within(dialog).findByRole("button", { name: /Find emails that need a reply/ }));
      expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({ kind: "work", workRoute: "chat", chatView: "draft" }));
      expect(useRetainedComposerDrafts.getState().drafts["new:global"]?.text).toMatch(/still need a reply from me.*Don't send anything\./);
    });

    it("keeps an unsent draft and swaps an untouched earlier suggestion", () => {
      useConnection.setState({ userId: "user_1" } as never);
      const draft = () => useRetainedComposerDrafts.getState().drafts["new:global"]?.text;
      seedNewChatDraft("Find emails that need a reply.");
      seedNewChatDraft("List my GitHub repos.");
      expect(draft()).toBe("List my GitHub repos.");
      const identity = desktopComposerDraftIdentity(useConnection.getState() as never);
      useRetainedComposerDrafts.getState().update(identity, (current) => ({ ...current, "new:global": { ...current["new:global"]!, text: "my unsent idea", projectId: "proj_work" } }));
      seedNewChatDraft("Find emails that need a reply.");
      expect(draft()).toBe("my unsent idea\n\nFind emails that need a reply.");
      // The project the owner picked for this draft stays picked.
      expect(useRetainedComposerDrafts.getState().drafts["new:global"]?.projectId).toBe("proj_work");
      // A second Try swaps only the suggestion; the owner's words stay.
      seedNewChatDraft("List my GitHub repos.");
      expect(draft()).toBe("my unsent idea\n\nList my GitHub repos.");
    });
  });

  describe("after Get started", () => {
    function renderAfter(state: unknown) {
      const port: GetStartedPort = { load: vi.fn(async () => state), save: vi.fn() };
      render(
        <GetStartedAnswersProvider scope="test">
          <GetStartedGate port={port} zIndex={1} />
          <GettingStartedPopover />
        </GetStartedAnswersProvider>,
      );
    }

    it("reopens on every load until done when setup was skipped", async () => {
      renderAfter({ status: "skipped", skippedAt: "2026-10-22T10:00:00.000Z" });
      expect(await screen.findByRole("dialog", { name: "Getting started" })).not.toBeNull();
    });

    it("offers to create a chosen bot whose creation failed, and retries it", async () => {
      let created = false;
      const api = makeApi({
        "/api/integrations": [],
        "/api/workspace/projects": { projects: [] },
        "/api/chats?limit=1": { items: [] },
      });
      const baseGet = api.get.getMockImplementation();
      api.get.mockImplementation(async (path: string, ...rest: unknown[]) => path === "/api/chat-agents"
        ? { enabled: true, agents: created ? [{ id: "bot_write001", archived: false, createdAt: "2026-10-22T10:00:00.000Z", recipeRef: { recipeId: "writing-bot", version: 1 } }] : [] }
        : path === "/api/settings/get-started/bots" ? { bots: { "writing-bot": created ? { status: "created", agentId: "bot_write001" } : { status: "pending" } } }
          : baseGet?.(path, ...rest));
      api.post.mockImplementation(async (path: string) => {
        if (path === "/api/settings/get-started/bots") {
          created = true;
          return { bots: { "writing-bot": "ready" } };
        }
        return { chatId: null };
      });
      useConnection.setState({ api: api as never });
      renderAfter({ status: "completed", completedAt: "2026-10-22T10:00:00.000Z", answers: { goals: [], tools: [], bots: ["writing-bot"] } });
      const dialog = await screen.findByRole("dialog", { name: "Getting started" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Create Writing Bot" }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/settings/get-started/bots", {}));
      expect(await within(dialog).findByRole("button", { name: "Chat with Writing Bot" })).not.toBeNull();
    });

    it("opens an added bot's own chat and App Gallery from the checklist", async () => {
      const api = makeApi({
        "/api/integrations": [],
        "/api/workspace/projects": { projects: [] },
        "/api/chats?limit=1": { items: [] },
        "/api/chat-agents": {
          enabled: true,
          agents: [{ id: "bot_write001", archived: false, createdAt: "2026-10-22T10:00:00.000Z", recipeRef: { recipeId: "writing-bot", version: 1 } }],
        },
        "/api/chat-agents/bot_write001/direct-chat": { chatId: null },
        "/api/settings/get-started/bots": { bots: { "writing-bot": { status: "created", agentId: "bot_write001" } } },
      });
      api.post.mockResolvedValue({ chatId: "chat_writer0001" });
      useConnection.setState({ api: api as never });
      // A closed or minimized window must come back, not just its tab.
      const activate = vi.spyOn(useDesktopSurfaces.getState(), "activateSurface");
      renderAfter({ status: "completed", completedAt: "2026-10-22T10:00:00.000Z", answers: { goals: [], tools: ["linear"], bots: ["writing-bot"] } });
      const dialog = await screen.findByRole("dialog", { name: "Getting started" });
      expect(await within(dialog).findByRole("button", { name: "Connect Linear" })).not.toBeNull();
      fireEvent.click(await within(dialog).findByRole("button", { name: "Chat with Writing Bot" }));
      await waitFor(() => expect(useTabs.getState().tabs).toContainEqual(
        expect.objectContaining({ kind: "work", workRoute: "chat", chatId: "chat_writer0001" }),
      ));
      expect(api.post).toHaveBeenCalledWith("/api/chat-agents/bot_write001/direct-chat", {});
      const chatTab = useTabs.getState().tabs.find((tab) => tab.kind === "work" && tab.chatId === "chat_writer0001");
      expect(activate).toHaveBeenCalledWith(chatTab?.id);
      fireEvent.click(within(dialog).getByTestId("getting-started-app-gallery"));
      const galleryTab = useTabs.getState().tabs.find((tab) => tab.kind === "app" && tab.slug === "app-gallery");
      expect(galleryTab).toBeDefined();
      expect(activate).toHaveBeenLastCalledWith(galleryTab?.id);
    });

    it("leads with the owner's answers and shows an icon on every step, or Try once it is done", async () => {
      renderAfter({ status: "completed", completedAt: "2026-10-22T10:00:00.000Z", answers: { goals: ["code"], tools: ["codex"] } });
      const dialog = await screen.findByRole("dialog", { name: "Getting started" });
      const rows = await waitFor(() => {
        const buttons = within(dialog).getAllByRole("button").filter((button) => button.dataset.testid !== "getting-started-app-gallery");
        expect(buttons[0].textContent).toContain("Log in to Codex");
        return buttons;
      });
      expect(rows).toHaveLength(5);
      for (const row of rows) expect(row.querySelector("svg") ?? within(row).queryByText("Try")).not.toBeNull();
      expect(within(dialog).getByTestId("getting-started-app-gallery").textContent).toContain("Build your first app in App Gallery");
    });
  });

  it("stays closed while the onboarding widget is showing, but still opens from its button", async () => {
    localStorage.removeItem(gettingStartedAutoOpenKey("neo", "primary"));
    function WidgetShowing() {
      useGettingStartedAutoOpenSuppression();
      return null;
    }
    render(<><WidgetShowing /><GettingStartedPopover /></>);
    const trigger = await screen.findByRole("button", { name: "Getting started — 3 of 5" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    expect(localStorage.getItem(gettingStartedAutoOpenKey("neo", "primary"))).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
  });

  it("keeps the Getting started toggle in Help with only the app summary when this computer serves the app", async () => {
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
        <GettingStartedPopover helpMenu={{ onSupport: vi.fn(), discordIcon: <span /> }} />
      </GettingStartedAppProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help", exact: true }));
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    fireEvent.click(await screen.findByRole("button", { name: /^Getting started — 0 of 12 done/ }));
    const popover = await screen.findByRole("dialog", { name: "Getting started" });
    expect(screen.queryByRole("button", { name: /^Getting started — \d+ of 5/ })).toBeNull();
    fireEvent.click(within(popover).getByRole("button", { name: /Open Getting started/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());
    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(0));
  });

  it("replaces Help with the checklist and lets Help reopen without overlapping", async () => {
    render(<GettingStartedPopover helpMenu={{ onSupport: vi.fn(), discordIcon: <span /> }} />);
    fireEvent.click(screen.getByRole("button", { name: "Help", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Getting started — 3 of 5" }));
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Support chat" })).toBeNull();
    expect(useUi.getState().rendererOverlayCount).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Help", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Help" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Getting started —/ }));
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  });

  it("stays open until the title-bar button is clicked again", async () => {
    render(<><button type="button">Outside</button><GettingStartedPopover /></>);

    const trigger = await screen.findByRole("button", { name: "Getting started — 3 of 5" });
    const api = useConnection.getState().api!;
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    expect(screen.getByText("3 of 5")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Connect email & calendar" })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();

    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    await waitFor(() => expect(api.get.mock.calls.filter(([path]) => path === "/api/github/status")).toHaveLength(3));
  });

  it("matches the Figma typography, spacing, colors, and icon sizing", async () => {
    render(<GettingStartedPopover />);
    const api = useConnection.getState().api!;
    fireEvent.click(await screen.findByRole("button", { name: "Getting started — 3 of 5" }));

    const dialog = screen.getByRole("dialog", { name: "Getting started" });
    expect(dialog.style.fontFamily).toContain("Inter");
    expect(dialog.style.background).toBe("rgb(255, 255, 255)");
    expect(dialog.style.borderColor).toBe("rgb(235, 234, 230)");
    expect(dialog.className).toContain("w-[252px]");
    expect(dialog.className).toContain("rounded-[12px]");

    const heading = screen.getByRole("heading", { name: "Getting started" });
    expect(heading.style.fontSize).toBe("16px");
    expect(heading.style.fontWeight).toBe("400");
    expect(heading.style.lineHeight).toBe("normal");
    expect(heading.style.color).toBe("rgb(20, 20, 19)");

    const counter = screen.getByTestId("getting-started-counter");
    expect(counter.style.fontSize).toBe("11px");
    expect(counter.style.fontWeight).toBe("500");
    expect(counter.style.lineHeight).toBe("normal");
    expect(counter.style.color).toBe("rgb(150, 150, 143)");

    const progress = screen.getByTestId("getting-started-progress");
    expect(progress.className).toContain("pb-4");
    expect(progress.className).not.toContain("items-center");
    expect(screen.getByTestId("getting-started-progress-track").style.background)
      .toBe("rgb(225, 225, 216)");
    expect(screen.getByTestId("getting-started-progress-fill").style.background)
      .toBe("rgb(46, 58, 42)");
    expect(screen.getByTestId("getting-started-progress-fill").className).not.toContain("rounded");

    const emailRow = screen.getByRole("button", { name: "Connect email & calendar" });
    expect(emailRow.className).toContain("gap-3");
    expect(emailRow.className).toContain("py-2");
    expect(emailRow.querySelector(":scope > svg:last-child")?.getAttribute("width")).toBe("16");
    expect(screen.getByRole("button", { name: "Set up billing" })
      .querySelector("img")?.getAttribute("width")).toBe("12");
    expect(screen.getByRole("button", { name: "Log in to Codex / Claude" })).not.toBeNull();
    await waitFor(() => expect(api.get.mock.calls.filter(([path]) => path === "/api/github/status")).toHaveLength(2));
  });

  it("consumes the shared onboarding brand palette", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "desktop/src/renderer/src/features/onboarding/GettingStartedPopover.tsx",
    ), "utf8");

    expect(source).toContain('from "@matrix-os/brand"');
    expect(source).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("opens the relevant setup surface without closing the popover", async () => {
    render(<GettingStartedPopover />);
    const api = useConnection.getState().api!;
    fireEvent.click(await screen.findByRole("button", { name: "Getting started — 3 of 5" }));
    // Connect rows start the app's sign-in now; a step without one still opens its Settings page.
    fireEvent.click(screen.getByRole("button", { name: "Log in to Codex / Claude" }));

    expect(useUi.getState().requestedSettingsSection).toBe("agents-providers");
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "settings", title: "Settings" }),
    ]);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    await waitFor(() => expect(api.get.mock.calls.filter(([path]) => path === "/api/github/status")).toHaveLength(2));
  });
});
