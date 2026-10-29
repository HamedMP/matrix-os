// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GettingStartedAppProgress, GettingStartedResults } from "@matrix-os/contracts";
import { useOnboardingTaskRequests } from "../../packages/ui/src/onboarding-widget/task-requests";
import {
  GettingStartedAppProvider,
  useGettingStartedApp,
  GettingStartedAppView,
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

function renderApp(port: GettingStartedAppPort, props: Partial<React.ComponentProps<typeof GettingStartedAppProvider>> = {}) {
  const onAction = vi.fn();
  const onToast = vi.fn();
  const view = render(
    <GettingStartedAppProvider port={port} refreshMs={25} onToast={onToast} {...props}>
      <GettingStartedAppView onAction={onAction} />
    </GettingStartedAppProvider>,
  );
  return { ...view, onAction, onToast };
}

describe("Getting started app view", () => {
  it("shows the header, hero and the task grid from the Figma design", async () => {
    renderApp(makePort());
    expect(await screen.findByText("0 of 10 done")).toBeTruthy();
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

  it("marks done tasks and moves the hero to the next task", async () => {
    const port = makePort({ results: () => results({ ...slackConnected, chats: fulfilled({ items: [{ id: "chat_1" }] }) }) });
    renderApp(port);
    expect(await screen.findByText("2 of 10 done")).toBeTruthy();
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

  it("says the rest can't be checked yet when only unavailable tasks remain", async () => {
    const port = makePort({ results: () => results({
      ...slackConnected,
      github: fulfilled({ authenticated: true }),
      agents: fulfilled({ agents: [{ agent: "codex", status: "available" }] }),
      chats: fulfilled({ items: [{ id: "chat_1" }] }),
    }) });
    renderApp(port);
    expect(await screen.findByText("4 of 10 done")).toBeTruthy();
    expect(screen.getByText("The rest can't be checked yet")).toBeTruthy();
    expect(screen.queryByText("You're all set")).toBeNull();
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
    expect(await screen.findByText("1 of 10 done")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Get the mobile app/ })).getByText("Done")).toBeTruthy();
  });

  it("maps each card to its destination", async () => {
    const { onAction } = renderApp(makePort());
    fireEvent.click(await screen.findByRole("button", { name: /Slack/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "settings", section: "integrations" });
    // No onboarding widget is mounted here, so a starter task starts in Chat instead.
    fireEvent.click(screen.getByRole("button", { name: /Research anything/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "chat", prompt: "Research anything" });
    fireEvent.click(screen.getByRole("button", { name: /Stuck\? Chat with us/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "support" });
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
    const { onToast } = renderApp(port);
    await screen.findByText("0 of 10 done");
    connected = true;
    await waitFor(() => expect(port.award).toHaveBeenCalledWith("slack", false, expect.any(AbortSignal)));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({ title: "Slack connected", points: 20 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(port.award.mock.calls.filter(([taskId]) => taskId === "slack")).toHaveLength(1);
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
    await screen.findByText("0 of 10 done");
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
    const { onToast } = renderApp(port);
    await screen.findByText("0 of 10 done");
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
    await screen.findByText("0 of 10 done");
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
    await screen.findByText("0 of 10 done");
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
    useOnboardingTaskRequests(onTask);
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

  it("keeps a line icon when an integration has no logo", async () => {
    renderApp(makePort({ logos: {} }));
    const whatsapp = await screen.findByRole("button", { name: /WhatsApp/ });
    expect(whatsapp.querySelector("img")).toBeNull();
  });

  it("celebrates a task that turns done while the owner is here", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    renderApp(port);
    await screen.findByText("0 of 10 done");
    connected = true;
    await waitFor(() => expect(screen.getByRole("button", { name: /Slack/ }).className).toContain("mxo-gsa__card--celebrate"));
    expect(screen.getByText(/Slack connected, nice\./)).toBeTruthy();
  });
});
