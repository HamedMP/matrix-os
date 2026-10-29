// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GettingStartedAppProgress, GettingStartedResults } from "@matrix-os/contracts";
import {
  GettingStartedAppProvider,
  GettingStartedAppView,
  gettingStartedAppAction,
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
    expect(screen.getByRole("heading", { name: "Put your agent to work" })).toBeTruthy();
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

  it("never marks an unavailable task done and shows no points chip on it", async () => {
    renderApp(makePort());
    const whatsapp = await screen.findByRole("button", { name: /WhatsApp/ });
    expect(within(whatsapp).queryByText("Done")).toBeNull();
    expect(within(whatsapp).queryByText("+20 pts")).toBeNull();
    expect(within(screen.getByRole("button", { name: /Slack/ })).getByText("+20 pts")).toBeTruthy();
  });

  it("maps each card to its destination", async () => {
    const { onAction } = renderApp(makePort());
    fireEvent.click(await screen.findByRole("button", { name: /Slack/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "settings", section: "integrations" });
    fireEvent.click(screen.getByRole("button", { name: "Start in chat" }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "chat", prompt: "Build me a habit tracker" });
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

  it("renders nothing when the feature is off", async () => {
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
    await waitFor(() => expect(port.award).toHaveBeenCalledWith("slack", true));
    expect(onToast).not.toHaveBeenCalled();
  });

  it("toasts once when a task turns done while Matrix is open", async () => {
    let connected = false;
    const port = makePort({ results: () => results(connected ? slackConnected : {}) });
    const { onToast } = renderApp(port);
    await screen.findByText("0 of 10 done");
    connected = true;
    await waitFor(() => expect(port.award).toHaveBeenCalledWith("slack", false));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("Slack connected +20 pts"));
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

  it("formats toast copy from the task table", () => {
    expect(gettingStartedAppToastText("github", 20)).toBe("GitHub connected +20 pts");
  });
});

