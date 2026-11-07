// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GettingStartedAppProgress, GettingStartedResults } from "@matrix-os/contracts";
import {
  useOnboardingTaskRequests,
  usePublishOnboardingWidgetStatus,
  type OnboardingWidgetStatus,
} from "../../packages/ui/src/onboarding-widget/task-requests";
import {
  GettingStartedAppOpenButton,
  GettingStartedAppProvider,
  GettingStartedAppView,
  useGettingStartedApp,
  gettingStartedAppAction,
  gettingStartedAppToast,
  gettingStartedAppToastText,
  type GettingStartedAppPort,
} from "../../packages/ui/src/getting-started-app/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fulfilled(value: unknown): PromiseFulfilledResult<unknown> {
  return { status: "fulfilled", value };
}

function results(overrides: Partial<GettingStartedResults> = {}): GettingStartedResults {
  return {
    github: fulfilled({ authenticated: false }),
    integrations: fulfilled([]),
    agents: fulfilled({ agents: [] }),
    projects: fulfilled({ projects: [] }),
    chats: fulfilled({ items: [] }),
    billing: fulfilled({ access: { runtimeProxyAllowed: false } }),
    ...overrides,
  };
}

const slackConnected = { integrations: fulfilled([{ id: "c1", service: "slack", status: "active" }]) };

function makePort(options: {
  results?: () => GettingStartedResults;
  progress?: GettingStartedAppProgress | null;
  autoOpen?: boolean;
  desktopIconPlaced?: boolean;
  logos?: Record<string, string>;
} = {}) {
  let progress: GettingStartedAppProgress = options.progress ?? { awards: [], total: 0 };
  const port = {
    loadResults: vi.fn(async () => (options.results ?? (() => results()))()),
    loadProgress: vi.fn(async () => (options.progress === null ? null : progress)),
    award: vi.fn(async (taskId: string, _silent: boolean) => {
      const already = progress.awards.some((award) => award.taskId === taskId);
      if (!already) {
        const points = taskId === "first-prompt" ? 50 : 20;
        progress = {
          awards: [...progress.awards, { taskId: taskId as never, points, awardedAt: "2026-10-29T10:00:00.000Z" }],
          total: progress.total + points,
        };
      }
      const recorded = progress.awards.find((award) => award.taskId === taskId);
      return { awarded: !already, points: recorded?.points ?? 0, total: progress.total };
    }),
    claimAutoOpen: vi.fn(async () => options.autoOpen ?? false),
    desktopIconPlaced: vi.fn(async (_signal?: AbortSignal) => options.desktopIconPlaced ?? false),
    markDesktopIconPlaced: vi.fn(async (_signal?: AbortSignal) => undefined),
    loadLogos: vi.fn(async (_signal: AbortSignal) => options.logos ?? {}),
  } satisfies GettingStartedAppPort;
  return port;
}

function WidgetStub({ status, onTask = () => undefined, onShow = () => undefined }: {
  status: OnboardingWidgetStatus;
  onTask?(taskId: string): void;
  onShow?(): void;
}) {
  useOnboardingTaskRequests(onTask, onShow);
  usePublishOnboardingWidgetStatus(status);
  return null;
}

function renderApp(
  port: GettingStartedAppPort,
  props: Partial<React.ComponentProps<typeof GettingStartedAppProvider>> = {},
  viewProps: { visible?: boolean } = {},
) {
  const onAction = vi.fn();
  const onToast = vi.fn();
  const view = render(
    <GettingStartedAppProvider port={port} refreshMs={25} onToast={onToast} {...props}>
      <GettingStartedAppView onAction={onAction} {...viewProps} />
    </GettingStartedAppProvider>,
  );
  return { ...view, onAction, onToast };
}

describe("Getting started app view", () => {
  it("shows the header, hero and the task grid from the Figma design", async () => {
    renderApp(makePort());
    expect(await screen.findByText("0 of 12 done")).toBeTruthy();
    expect(screen.getByText("Getting started")).toBeTruthy();
    expect(screen.getByLabelText("0 points")).toBeTruthy();
    expect(screen.getByText("Start here")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What should I start on?" })).toBeTruthy();
    const starters = within(screen.getByRole("list", { name: "Starter tasks" }));
    for (const label of ["Research anything", "Plan my week", "Build a website", "Work on my code"]) {
      expect(starters.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(starters.getByText("Needs Calendar")).toBeTruthy();
    expect(starters.getByText("Needs GitHub")).toBeTruthy();
    for (const section of ["Build", "Connect", "Go further"]) {
      expect(screen.getByRole("heading", { name: section })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stuck\? Chat with us/ })).toBeTruthy();
  });

  it("mirrors the widget while it is open in the corner instead of listing the starter tasks again", async () => {
    render(<WidgetStub status={{ open: true, activity: { kind: "choosing" } }} />);
    renderApp(makePort());
    expect(await screen.findByRole("heading", { name: "Pick your first task in the corner" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Starter tasks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show Matrix panel" })).toBeNull();
  });

  it("lists the starter tasks itself once the widget is minimized", async () => {
    render(<WidgetStub status={{ open: false, activity: { kind: "choosing" } }} />);
    renderApp(makePort());
    expect(await screen.findByRole("list", { name: "Starter tasks" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Pick your first task in the corner" })).toBeNull();
  });

  it("follows a task the widget is running, and brings a minimized widget back", async () => {
    const onShow = vi.fn();
    render(<WidgetStub status={{ open: false, activity: { kind: "running", title: "Plan my week" } }} onShow={onShow} />);
    renderApp(makePort({ results: () => results({ chats: fulfilled({ items: [{ id: "chat_1" }] }) }) }));
    expect(await screen.findByRole("heading", { name: "Matrix is working on Plan my week" })).toBeTruthy();
    expect(screen.queryByText("Up next")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Matrix panel" }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("goes back to Up next once the widget's task is done", async () => {
    render(<WidgetStub status={{ open: true, activity: { kind: "done", title: "Plan my week" } }} />);
    renderApp(makePort({ results: () => results({ chats: fulfilled({ items: [{ id: "chat_1" }] }) }) }));
    expect(await screen.findByText("Up next")).toBeTruthy();
  });

  it("keeps the owner's name and prompts out of session replay, like the widget it mirrors", async () => {
    render(<WidgetStub status={{ open: true, activity: { kind: "running", title: "Draft my salary negotiation email" } }} />);
    const { container } = renderApp(makePort({ results: () => results({ chats: fulfilled({ items: [{ id: "chat_1" }] }) }) }));
    const title = await screen.findByRole("heading", { name: "Matrix is working on Draft my salary negotiation email" });
    expect(title.closest(".ph-no-capture")).toBeTruthy();
    expect(container.querySelector(".mxo-gsa")?.classList.contains("ph-no-capture")).toBe(true);
  });

  it("marks done tasks and moves the hero to the next task", async () => {
    const port = makePort({ results: () => results({ ...slackConnected, chats: fulfilled({ items: [{ id: "chat_1" }] }) }) });
    renderApp(port);
    expect(await screen.findByText("2 of 12 done")).toBeTruthy();
    expect(screen.getByText("Up next")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Slack/ })).getByText("Done")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("70 points")).toBeTruthy());
  });

  it("shows a loading hero until status arrives, not 'all set'", async () => {
    const port = makePort();
    port.loadResults.mockImplementation(() => new Promise(() => undefined));
    renderApp(port);
    expect(await screen.findByText("Loading your tasks…")).toBeTruthy();
    expect(screen.queryByText("You're all set")).toBeNull();
  });

  it("celebrates Matrix fully unlocked once every task it can check is done", async () => {
    const port = makePort({ results: () => results({
      integrations: fulfilled([
        { id: "c1", service: "slack", status: "active" },
        { id: "c4", service: "gmail", status: "active" },
        { id: "c5", service: "google_calendar", status: "active" },
      ]),
      github: fulfilled({ authenticated: true }),
      agents: fulfilled({ agents: [{ agent: "codex", status: "available" }] }),
      chats: fulfilled({ items: [{ id: "chat_1" }] }),
    }) });
    const { onAction } = renderApp(port);
    expect(await screen.findByText("6 of 12 done")).toBeTruthy();
    const unlocked = await screen.findByRole("region", { name: "Matrix unlocked" });
    expect(within(unlocked).getByRole("heading", { name: "Matrix is fully unlocked" })).toBeTruthy();
    await waitFor(() => expect(within(unlocked).getByText("150 pts collected")).toBeTruthy());
    expect(within(unlocked).getByText("6 tasks done")).toBeTruthy();
    expect(screen.queryByText("Up next")).toBeNull();
    fireEvent.click(within(unlocked).getByRole("button", { name: "Put Matrix to work" }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "chat" });
  });

  it("does not claim Matrix is unlocked when status checks fail", async () => {
    const down: PromiseRejectedResult = { status: "rejected", reason: new Error("down") };
    renderApp(makePort({ results: () => results({ integrations: down, agents: down, github: down, chats: fulfilled({ items: [{ id: "chat_1" }] }) }) }));
    expect(await screen.findByRole("heading", { name: "Some checks didn't load" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Matrix unlocked" })).toBeNull();
  });

  it("waits for the last award to land before the unlocked banner", async () => {
    const port = makePort({ results: () => results({
      integrations: fulfilled(["slack", "gmail", "google_calendar"].map((service, i) => ({ id: `c${i}`, service, status: "active" }))),
      github: fulfilled({ authenticated: true }),
      agents: fulfilled({ agents: [{ agent: "codex", status: "available" }] }),
      chats: fulfilled({ items: [{ id: "chat_1" }] }),
    }) });
    const releases: Array<() => void> = [];
    const award = port.award.getMockImplementation()!;
    port.award.mockImplementation((taskId, silent) => new Promise((resolve) => {
      releases.push(() => resolve(award(taskId, silent)));
    }));
    renderApp(port);
    expect(await screen.findByText("6 of 12 done")).toBeTruthy();
    await waitFor(() => expect(releases.length).toBe(6));
    expect(screen.queryByRole("region", { name: "Matrix unlocked" })).toBeNull();
    await act(async () => { for (const release of releases) release(); });
    expect(await screen.findByRole("region", { name: "Matrix unlocked" })).toBeTruthy();
  });

  it("does not celebrate while a checkable task is still open", async () => {
    renderApp(makePort({ results: () => results({ ...slackConnected, chats: fulfilled({ items: [{ id: "chat_1" }] }) }) }));
    expect(await screen.findByText("Up next")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Matrix unlocked" })).toBeNull();
  });

  it("shows the Gmail and Google Calendar cards with their catalog logos", async () => {
    renderApp(makePort({ logos: { gmail: "https://cdn.example.com/gmail.svg", "google-calendar": "https://cdn.example.com/gcal.svg" } }));
    const gmail = await screen.findByRole("button", { name: /Gmail/ });
    const calendar = screen.getByRole("button", { name: /Google Calendar/ });
    await waitFor(() => expect(gmail.querySelector('img[src="https://cdn.example.com/gmail.svg"]')).toBeTruthy());
    expect(calendar.querySelector('img[src="https://cdn.example.com/gcal.svg"]')).toBeTruthy();
    expect(within(calendar).getByText("+20 pts")).toBeTruthy();
  });

  it("keeps points on a task Matrix cannot check yet, and never marks it done", async () => {
    renderApp(makePort({ results: () => results({ integrations: fulfilled([{ id: "c3", service: "whatsapp", status: "active" }]) }) }));
    const whatsapp = await screen.findByRole("button", { name: /WhatsApp/ });
    expect(within(whatsapp).queryByText("Done")).toBeNull();
    expect(within(whatsapp).getByText("+20 pts")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Slack/ })).getByText("+20 pts")).toBeTruthy();
  });

  it("shows earned tasks as done even when their status can't be checked", async () => {
    renderApp(makePort({
      progress: { awards: [{ taskId: "mobile-app", points: 20, awardedAt: "2026-10-28T10:00:00.000Z" }], total: 20 },
    }));
    expect(await screen.findByText("1 of 12 done")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Get the mobile app/ })).getByText("Done")).toBeTruthy();
  });

  it("stops showing Done when an earned connection is disconnected, and keeps its points", async () => {
    renderApp(makePort({
      progress: { awards: [{ taskId: "slack", points: 20, awardedAt: "2026-10-28T10:00:00.000Z" }], total: 20 },
    }));
    const slack = await screen.findByRole("button", { name: /Slack/ });
    await waitFor(() => expect(within(slack).getByText("20 pts earned")).toBeTruthy());
    expect(within(slack).queryByText("Done")).toBeNull();
    expect(within(slack).queryByText("+20 pts")).toBeNull();
    expect(screen.getByText("0 of 12 done")).toBeTruthy();
    expect(screen.getByText("20 pts")).toBeTruthy();
  });

  it("offers a disconnected task as up next without promising its points again", async () => {
    renderApp(makePort({
      results: () => results({ chats: fulfilled({ items: [{ id: "chat-1" }] }) }),
      progress: { awards: [
        { taskId: "first-prompt", points: 50, awardedAt: "2026-10-28T10:00:00.000Z" },
        { taskId: "gmail", points: 20, awardedAt: "2026-10-28T10:00:00.000Z" },
      ], total: 70 },
    }));
    const title = await screen.findByRole("heading", { name: "Gmail" });
    const hero = title.parentElement!;
    expect(within(hero).getByText("20 pts earned")).toBeTruthy();
    expect(within(hero).queryByText("+20 pts")).toBeNull();
  });

  it("shows the next task's logo large in the Up next panel", async () => {
    renderApp(makePort({
      results: () => results({ chats: fulfilled({ items: [{ id: "chat-1" }] }) }),
      logos: { gmail: "https://cdn.example.com/gmail.svg" },
    }));
    const title = await screen.findByRole("heading", { name: "Gmail" });
    const panel = title.closest(".mxo-gsa__next") as HTMLElement;
    await waitFor(() => expect(panel.querySelector('.mxo-gsa__next-art img[src="https://cdn.example.com/gmail.svg"]')).toBeTruthy());
    expect(within(panel).getByRole("button", { name: "Connect" }).className).toContain("mxo-gsa__primary--brand");
  });

  it("keeps a sent first prompt done after its chats are deleted", async () => {
    renderApp(makePort({
      progress: { awards: [{ taskId: "first-prompt", points: 50, awardedAt: "2026-10-28T10:00:00.000Z" }], total: 50 },
    }));
    expect(await screen.findByText("1 of 12 done")).toBeTruthy();
    expect(screen.queryByText("What should I start on?")).toBeNull();
  });

  it("maps each card to its destination", async () => {
    const { onAction } = renderApp(makePort());
    fireEvent.click(await screen.findByRole("button", { name: /Slack/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "connect", service: "slack" });
    // No onboarding widget is mounted here, so a starter task starts in Chat instead.
    fireEvent.click(screen.getByRole("button", { name: /Research anything/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "chat", prompt: "Research anything" });
    fireEvent.click(screen.getByRole("button", { name: /Stuck\? Chat with us/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "support" });
  });

  it("starts each app's own sign-in from its card instead of opening Settings", async () => {
    const { onAction } = renderApp(makePort());
    fireEvent.click(await screen.findByRole("button", { name: /Gmail/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "connect", service: "gmail" });
    fireEvent.click(screen.getByRole("button", { name: /Google Calendar/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "connect", service: "google_calendar" });
    fireEvent.click(within(screen.getByRole("region", { name: "Connect" })).getByRole("button", { name: /GitHub/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "connect", service: "github" });
    // WhatsApp is a messaging channel set up in Settings, not an app sign-in.
    fireEvent.click(screen.getByRole("button", { name: /WhatsApp/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "settings", section: "integrations" });
  });

  it("shows a sign-in in progress and one that did not finish on the card", async () => {
    const port = makePort();
    const { rerender } = renderApp(port, { connections: { connectingService: "gmail", failedServices: [], changeCount: 0 } });
    const gmail = await screen.findByRole("button", { name: /Gmail/ });
    expect(within(gmail).getByText("Connecting…")).toBeTruthy();
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={25} onToast={vi.fn()} connections={{ connectingService: null, failedServices: ["google_calendar"], changeCount: 0 }}>
        <GettingStartedAppView onAction={vi.fn()} />
      </GettingStartedAppProvider>,
    );
    const calendar = await screen.findByRole("button", { name: /Google Calendar/ });
    expect(within(calendar).getByText("Didn't connect, try again")).toBeTruthy();
  });

  it("re-reads progress as soon as a connection changes", async () => {
    const port = makePort();
    const { rerender } = renderApp(port, { refreshMs: 60_000, connections: { connectingService: null, failedServices: [], changeCount: 0 } });
    await screen.findByText("0 of 12 done");
    const reads = port.loadResults.mock.calls.length;
    port.loadResults.mockImplementation(async () => results({ integrations: fulfilled([{ id: "c4", service: "gmail", status: "active" }]) }));
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={60_000} onToast={vi.fn()} connections={{ connectingService: null, failedServices: [], changeCount: 1 }}>
        <GettingStartedAppView onAction={vi.fn()} />
      </GettingStartedAppProvider>,
    );
    await waitFor(() => expect(port.loadResults.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText("1 of 12 done")).toBeTruthy();
  });

  it("keeps a new connection when an older status read finishes last", async () => {
    const stale: Array<(value: GettingStartedResults) => void> = [];
    const port = makePort();
    const { rerender } = renderApp(port, { refreshMs: 60_000, connections: { connectingService: null, failedServices: [], changeCount: 0 } });
    await screen.findByText("0 of 12 done");
    // A poll is in flight with the old status when the sign-in lands and a newer read starts.
    port.loadResults.mockImplementationOnce(() => new Promise((resolve) => { stale.push(resolve); }));
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={60_000} onToast={vi.fn()} connections={{ connectingService: null, failedServices: [], changeCount: 1 }}>
        <GettingStartedAppView onAction={vi.fn()} />
      </GettingStartedAppProvider>,
    );
    await waitFor(() => expect(stale).toHaveLength(1));
    port.loadResults.mockImplementationOnce(async () => results({ integrations: fulfilled([{ id: "c4", service: "gmail", status: "active" }]) }));
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={60_000} onToast={vi.fn()} connections={{ connectingService: null, failedServices: [], changeCount: 2 }}>
        <GettingStartedAppView onAction={vi.fn()} />
      </GettingStartedAppProvider>,
    );
    expect(await screen.findByText("1 of 12 done")).toBeTruthy();
    await act(async () => { stale[0]!(results()); await Promise.resolve(); });
    expect(screen.getByText("1 of 12 done")).toBeTruthy();
  });

  it("disables Invite friends until referrals exist", async () => {
    renderApp(makePort());
    const invite = await screen.findByRole("button", { name: /Invite friends/ });
    expect((invite as HTMLButtonElement).disabled).toBe(true);
    expect(within(invite).getByText("Coming soon")).toBeTruthy();
    expect(gettingStartedAppAction("invite-friends")).toBeNull();
  });

  it("renders nothing when the computer predates the app", async () => {
    const port = makePort({ progress: null });
    const { container } = renderApp(port);
    await waitFor(() => expect(port.loadProgress).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("Getting started app awards", () => {
  it("awards tasks that are already done silently, without a toast", async () => {
    const port = makePort({ results: () => results(slackConnected) });
    const { onToast } = renderApp(port);
    await waitFor(() => expect(port.award).toHaveBeenCalledWith("slack", true, expect.any(AbortSignal)));
    expect(onToast).not.toHaveBeenCalled();
  });

  it("toasts once when a task turns done while Matrix is open", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    // The app window is minimized, so the corner toast tells the owner.
    const { onToast } = renderApp(port, {}, { visible: false });
    await screen.findByText("0 of 12 done");
    connected = true;
    await waitFor(() => expect(port.award).toHaveBeenCalledWith("slack", false, expect.any(AbortSignal)));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({ title: "Slack connected", points: 20 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(port.award.mock.calls.filter(([taskId]) => taskId === "slack")).toHaveLength(1);
  });

  it("celebrates in the app instead of a corner toast while the app is showing", async () => {
    let chatted = false;
    const port = makePort({ results: () => results(chatted ? { chats: fulfilled({ items: [{ id: "chat_1" }] }) } : {}) });
    const { onToast } = renderApp(port);
    await screen.findByRole("heading", { name: "What should I start on?" });
    chatted = true;
    const reward = await screen.findByRole("status", { name: "First task started, 50 points" });
    expect(within(reward).getByText("First task started")).toBeTruthy();
    expect(within(reward).getByText("+50 pts")).toBeTruthy();
    expect(onToast).not.toHaveBeenCalled();
    // The hero moves on to the next task once the reward has played.
    expect(await screen.findByText("Up next", undefined, { timeout: 4000 })).toBeTruthy();
  });

  it("toasts again once the app stops showing", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    const { onToast, rerender } = renderApp(port);
    await screen.findByText("0 of 12 done");
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={25} onToast={onToast}>
        <GettingStartedAppView onAction={vi.fn()} visible={false} />
      </GettingStartedAppProvider>,
    );
    connected = true;
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({ title: "Slack connected", points: 20 }));
  });

  it("does not award tasks the server already recorded", async () => {
    const port = makePort({
      results: () => results(slackConnected),
      progress: { awards: [{ taskId: "slack", points: 20, awardedAt: "2026-10-28T10:00:00.000Z" }], total: 20 },
    });
    renderApp(port);
    expect(await screen.findByLabelText("20 points")).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(port.award).not.toHaveBeenCalled();
  });

  it("keeps the grid working when points cannot load", async () => {
    const port = makePort();
    port.loadProgress.mockRejectedValue(new Error("down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderApp(port);
    expect(await screen.findByLabelText("Points unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
    expect(port.award).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("claims the automatic first open once when eligible", async () => {
    const port = makePort({ autoOpen: true });
    const onAutoOpen = vi.fn();
    const { rerender } = renderApp(port, { autoOpenEligible: true, onAutoOpen });
    await waitFor(() => expect(onAutoOpen).toHaveBeenCalledTimes(1));
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={25} autoOpenEligible onAutoOpen={onAutoOpen}>
        <GettingStartedAppView onAction={vi.fn()} />
      </GettingStartedAppProvider>,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(port.claimAutoOpen).toHaveBeenCalledTimes(1);
  });

  it("does not claim the automatic open when not eligible", async () => {
    const port = makePort({ autoOpen: true });
    renderApp(port, { autoOpenEligible: false });
    await screen.findByText("0 of 12 done");
    expect(port.claimAutoOpen).not.toHaveBeenCalled();
  });

  it("never moves the points badge backwards when award responses arrive out of order", async () => {
    const port = makePort({ results: () => results({ ...slackConnected, github: fulfilled({ authenticated: true }) }) });
    let releaseSlow: () => void = () => undefined;
    port.award.mockImplementation(async (taskId: string) => {
      if (taskId === "slack") {
        await new Promise<void>((resolve) => { releaseSlow = resolve; });
        return { awarded: true, points: 20, total: 20 };
      }
      return { awarded: true, points: 20, total: 40 };
    });
    renderApp(port);
    expect(await screen.findByLabelText("40 points")).toBeTruthy();
    await act(async () => { releaseSlow(); });
    expect(screen.getByLabelText("40 points")).toBeTruthy();
  });

  it("keeps the completion toast when the first award request fails", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    const realAward = port.award.getMockImplementation()!;
    port.award.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { onToast } = renderApp(port, {}, { visible: false });
    await screen.findByText("0 of 12 done");
    connected = true;
    await waitFor(() => expect(port.award).toHaveBeenCalledTimes(1));
    port.award.mockImplementation(realAward);
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({ title: "Slack connected", points: 20 }));
    expect(port.award.mock.calls.map(([, silent]) => silent)).toEqual([false, false]);
  });

  it("retries the automatic first open after a failed claim", async () => {
    const port = makePort({ autoOpen: true });
    port.claimAutoOpen.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onAutoOpen = vi.fn();
    renderApp(port, { autoOpenEligible: true, onAutoOpen });
    await waitFor(() => expect(onAutoOpen).toHaveBeenCalledTimes(1));
    expect(port.claimAutoOpen).toHaveBeenCalledTimes(2);
  });

  it("formats toast copy from the task table", () => {
    expect(gettingStartedAppToastText(gettingStartedAppToast("github", 20))).toBe("GitHub connected +20 pts");
  });
});


describe("Getting started app on a newer computer", () => {
  it("keeps working and keeps the total when progress names a task this build does not know", async () => {
    const port = makePort({
      results: () => results({ ...slackConnected }),
      progress: { awards: [{ taskId: "future-task", points: 40, awardedAt: "2026-10-29T10:00:00.000Z" }], total: 40 },
    });
    renderApp(port);
    await waitFor(() => expect(screen.getByLabelText("60 points")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
    expect(port.award).toHaveBeenCalledWith("slack", true, expect.anything());
  });
});

describe("Getting started app polling", () => {
  it("reads less often while no window is showing, and at full rate when one is", async () => {
    vi.useFakeTimers();
    try {
      const closed = makePort();
      render(<GettingStartedAppProvider port={closed} refreshMs={100} onToast={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      const closedReads = closed.loadResults.mock.calls.length;
      cleanup();
      const open = makePort();
      renderApp(open, { refreshMs: 100 });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(closedReads).toBe(3);
      expect(open.loadResults.mock.calls.length).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Getting started app availability", () => {
  it("reports when the computer serves the app, once per change", async () => {
    const port = makePort();
    const onEnabledChange = vi.fn();
    renderApp(port, { onEnabledChange });
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onEnabledChange).toHaveBeenCalledTimes(1);
  });

  it("says whether this computer serves the app: checking, then enabled or unavailable", async () => {
    function Availability() {
      return <span data-testid="availability">{useGettingStartedApp()?.availability ?? "none"}</span>;
    }
    const port = makePort();
    let resolve: (progress: GettingStartedAppProgress) => void = () => undefined;
    port.loadProgress.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<GettingStartedAppProvider port={port} refreshMs={25} onToast={vi.fn()}><Availability /></GettingStartedAppProvider>);
    expect(screen.getByTestId("availability").textContent).toBe("checking");
    await act(async () => resolve({ awards: [], total: 0 }));
    await waitFor(() => expect(screen.getByTestId("availability").textContent).toBe("enabled"));
    cleanup();
    render(<GettingStartedAppProvider port={makePort({ progress: null })} refreshMs={25} onToast={vi.fn()}><Availability /></GettingStartedAppProvider>);
    await waitFor(() => expect(screen.getByTestId("availability").textContent).toBe("unavailable"));
  });
});

describe("Getting started app after a computer switch", () => {
  it("ignores an automatic-open claim that settles after unmount", async () => {
    const port = makePort();
    let settle: (open: boolean) => void = () => undefined;
    port.claimAutoOpen.mockImplementation((signal?: AbortSignal) => new Promise<boolean>((resolve) => {
      settle = resolve;
      expect(signal).toBeInstanceOf(AbortSignal);
    }));
    const onAutoOpen = vi.fn();
    const { unmount } = renderApp(port, { autoOpenEligible: true, onAutoOpen });
    await waitFor(() => expect(port.claimAutoOpen).toHaveBeenCalledTimes(1));
    const signal = port.claimAutoOpen.mock.calls[0]?.[0] as AbortSignal | undefined;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { settle(true); });
    expect(onAutoOpen).not.toHaveBeenCalled();
  });

  it("drops an award toast that settles after unmount", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    let settle: () => void = () => undefined;
    port.award.mockImplementation(() => new Promise((resolve) => {
      settle = () => resolve({ awarded: true, points: 20, total: 20 });
    }));
    const { unmount, onToast } = renderApp(port);
    await screen.findByText("0 of 12 done");
    connected = true;
    await waitFor(() => expect(port.award).toHaveBeenCalled());
    unmount();
    await act(async () => { settle(); });
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe("Getting started desktop icon", () => {
  it("places the icon once the desktop is ready, then records it", async () => {
    const port = makePort();
    const onPlaceDesktopIcon = vi.fn(async () => "added" as const);
    const { rerender } = renderApp(port, { desktopIconReady: false, onPlaceDesktopIcon });
    await screen.findByText("0 of 12 done");
    expect(port.desktopIconPlaced).not.toHaveBeenCalled();
    rerender(
      <GettingStartedAppProvider port={port} refreshMs={25} desktopIconReady onPlaceDesktopIcon={onPlaceDesktopIcon}>
        <GettingStartedAppView onAction={vi.fn()} />
      </GettingStartedAppProvider>,
    );
    await waitFor(() => expect(port.markDesktopIconPlaced).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onPlaceDesktopIcon).toHaveBeenCalledTimes(1);
  });

  it("counts an icon that is already on the desktop as placed", async () => {
    const port = makePort();
    renderApp(port, { desktopIconReady: true, onPlaceDesktopIcon: vi.fn(async () => "already-present" as const) });
    await waitFor(() => expect(port.markDesktopIconPlaced).toHaveBeenCalledTimes(1));
  });

  it("never puts the icon back once it was placed (the owner may have removed it)", async () => {
    const port = makePort({ desktopIconPlaced: true });
    const onPlaceDesktopIcon = vi.fn(async () => "added" as const);
    renderApp(port, { desktopIconReady: true, onPlaceDesktopIcon });
    await waitFor(() => expect(port.desktopIconPlaced).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onPlaceDesktopIcon).not.toHaveBeenCalled();
    expect(port.markDesktopIconPlaced).not.toHaveBeenCalled();
  });

  it("does not record a failed save, and tries again on the next refresh", async () => {
    const port = makePort();
    const onPlaceDesktopIcon = vi.fn<() => Promise<"added" | "failed">>()
      .mockResolvedValueOnce("failed")
      .mockResolvedValue("added");
    renderApp(port, { desktopIconReady: true, onPlaceDesktopIcon });
    await waitFor(() => expect(onPlaceDesktopIcon).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(port.markDesktopIconPlaced).toHaveBeenCalledTimes(1));
  });
});

describe("Getting started as an extension of onboarding", () => {
  function WidgetListener({ onTask }: { onTask(taskId: string): void }) {
    useOnboardingTaskRequests(onTask, () => undefined);
    return null;
  }

  it("hands a starter task to the onboarding widget when one is mounted", async () => {
    const onTask = vi.fn();
    const onAction = vi.fn();
    render(
      <GettingStartedAppProvider port={makePort()} refreshMs={25}>
        <WidgetListener onTask={onTask} />
        <GettingStartedAppView onAction={onAction} />
      </GettingStartedAppProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Plan my week/ }));
    expect(onTask).toHaveBeenCalledWith("plan-week");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("drops the Needs tag once the app is connected", async () => {
    renderApp(makePort({ results: () => results({ github: fulfilled({ authenticated: false }), integrations: fulfilled([{ id: "c9", service: "github", status: "active" }]) }) }));
    const starters = within(await screen.findByRole("list", { name: "Starter tasks" }));
    expect(starters.queryByText("Needs GitHub")).toBeNull();
    expect(starters.getByText("Needs Calendar")).toBeTruthy();
  });

  it("shows the real integration logos on the Connect cards", async () => {
    const port = makePort({ logos: { slack: "https://logos.example/slack.svg", github: "https://logos.example/github.svg" } });
    renderApp(port);
    const slack = await screen.findByRole("button", { name: /Slack/ });
    await waitFor(() => expect(slack.querySelector("img")?.getAttribute("src")).toBe("https://logos.example/slack.svg"));
    expect(port.loadLogos).toHaveBeenCalledTimes(1);
  });

  it("falls back from a logo that fails to load", async () => {
    renderApp(makePort({ logos: { github: "https://logos.example/broken.svg" } }));
    const github = await screen.findByRole("button", { name: /Let agents work in your repos/ });
    const img = await waitFor(() => {
      const found = github.querySelector("img");
      if (!found) throw new Error("logo not rendered yet");
      return found;
    });
    fireEvent.error(img);
    await waitFor(() => expect(github.querySelector("img")).toBeNull());
  });

  it("keeps a line icon when an integration has no logo", async () => {
    renderApp(makePort({ logos: {} }));
    const whatsapp = await screen.findByRole("button", { name: /WhatsApp/ });
    expect(whatsapp.querySelector("img")).toBeNull();
  });

  it("celebrates a task that turns done while the owner is here", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    renderApp(port);
    await screen.findByText("0 of 12 done");
    connected = true;
    await waitFor(() => expect(screen.getByRole("button", { name: /Slack/ }).className).toContain("mxo-gsa__card--celebrate"));
    expect(screen.getByText(/Slack connected, nice\./)).toBeTruthy();
  });
});

describe("Getting started open button in the Help checklist", () => {
  it("opens the app full size, only where the computer serves it", async () => {
    const onOpen = vi.fn();
    const onOpened = vi.fn();
    render(
      <GettingStartedAppProvider port={makePort()} refreshMs={25} onToast={vi.fn()} onOpen={onOpen}>
        <GettingStartedAppOpenButton onOpened={onOpened} />
      </GettingStartedAppProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open Getting started" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <GettingStartedAppProvider port={makePort({ progress: null })} refreshMs={25} onToast={vi.fn()} onOpen={onOpen}>
        <GettingStartedAppOpenButton />
      </GettingStartedAppProvider>,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole("button", { name: "Open Getting started" })).toBeNull();
  });
});

describe("Getting started app styles", () => {
  it("takes its colors from @matrix-os/brand, with raw hex only as var() fallbacks", () => {
    const css = readFileSync(resolve(__dirname, "../../packages/ui/src/getting-started-app/getting-started-app.css"), "utf8");
    const withoutFallbacks = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/var\(--[\w-]+,[^()]*(\([^()]*\))?[^()]*\)/g, "");
    expect(withoutFallbacks.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });
});

