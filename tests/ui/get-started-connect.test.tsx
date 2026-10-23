// @vitest-environment jsdom
import React, { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import {
  GetStartedGate,
  useGetStartedConnect,
  useGetStartedConnectFailures,
  type GetStartedConnect,
  type GetStartedPort,
} from "../../packages/ui/src/get-started/index.js";
import { GET_STARTED_WIZARD_STEPS } from "../../packages/contracts/src/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function port(draft: Record<string, unknown>) {
  const saves: GetStartedUpdate[] = [];
  const value: GetStartedPort = {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 2, ...draft } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      if (update.type === "complete") return { status: "completed", completedAt: AT, answers: update.answers };
      if (update.type === "draft") return { status: "in_progress", updatedAt: AT, draft: update.draft };
      return { status: "skipped", skippedAt: AT };
    }),
  };
  return Object.assign(value, { saves });
}

const CATALOG = [
  { id: "twitter", name: "X", category: "Social" },
  { id: "slack", name: "Slack", category: "Communication", logoUrl: "https://example.test/slack.png" },
  { id: "github", name: "GitHub", category: "Developer", logoUrl: "https://example.test/github.png" },
  { id: "linear", name: "Linear", category: "Developer" },
  { id: "gmail", name: "Gmail", category: "Email" },
];

function makeConnector(initial: Partial<GetStartedConnect>) {
  const connect = vi.fn();
  let setState!: (next: Partial<GetStartedConnect>) => void;
  function Connector({ children }: { children: (value: GetStartedConnect) => ReactNode }) {
    const [state, set] = useState<Partial<GetStartedConnect>>(initial);
    setState = (next) => set((prev) => ({ ...prev, ...next }));
    return <>{children({
      availableServices: new Set(["github", "linear", "figma", "slack", "gmail", "google_calendar"]),
      connectedServices: new Set(),
      failedServices: new Set(),
      connectingService: null,
      logoUrls: new Map([["github", "https://example.test/github.png"]]),
      catalog: CATALOG,
      connectionsLoaded: true,
      unavailable: false,
      connect,
      ...state,
    })}</>;
  }
  return { Connector, connect, update: (next: Partial<GetStartedConnect>) => act(() => setState(next)) };
}

afterEach(() => {
  cleanup();
});

describe("Connect the tools you use", () => {
  it("keeps the owner in the wizard while an app sign-in is still under way", async () => {
    // Ending the wizard unmounts its connector, which would drop the sign-in without a word.
    const at = (step: (typeof GET_STARTED_WIZARD_STEPS)[number]): GetStartedPort => ({
      load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: GET_STARTED_WIZARD_STEPS.indexOf(step), goals: [], tools: [] } })),
      save: vi.fn(async () => ({ status: "completed", completedAt: AT, answers: { goals: [], tools: [] } })),
    });
    const summary = makeConnector({ connectingService: "gmail" });
    render(<GetStartedGate port={at("summary")} zIndex={1} connector={summary.Connector} />);
    const enter = await screen.findByRole("button", { name: "Enter your computer" });
    expect(enter).toBeDisabled();
    expect(screen.getByText("Waiting for your app sign-in to finish.")).toBeInTheDocument();
    summary.update({ connectingService: null });
    expect(enter).toBeEnabled();
    expect(screen.queryByText("Waiting for your app sign-in to finish.")).not.toBeInTheDocument();
    cleanup();
    render(<GetStartedGate port={at("name")} zIndex={1} connector={makeConnector({ connectingService: "gmail" }).Connector} />);
    expect(await screen.findByRole("button", { name: "Skip setup" })).toBeDisabled();
  });

  it("shows the Settings integrations list with the tools for the owner's goals first", async () => {
    const { Connector, connect } = makeConnector({});
    render(<GetStartedGate port={port({ name: "Sam", goals: ["code"], tools: [] })} zIndex={1} connector={Connector} />);
    expect(await screen.findByRole("heading", { name: "Connect the tools you use" })).toBeInTheDocument();
    const marketplace = screen.getByTestId("integrations-grid");
    expect(within(marketplace).getByRole("searchbox", { name: "Search integrations" })).toBeInTheDocument();
    // The tools that fit the goals lead, ahead of the category sections.
    const suggested = within(marketplace).getByRole("region", { name: "Suggested for your goals" });
    expect(within(suggested).getAllByTestId(/^integration-card-/).map((card) => card.dataset.testid))
      .toEqual(["integration-card-github", "integration-card-linear", "integration-card-slack"]);
    expect(within(marketplace).getAllByRole("region")[0]).toBe(suggested);
    expect(screen.getByTestId("integration-card-github").querySelector("img")).toHaveAttribute("src", "https://example.test/github.png");
    // Coding agents are not integrations, so they stay as choices above the list.
    expect(screen.getByText("Your coding agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects right on the step, shows it connected, and records it as a tool", async () => {
    const { Connector, connect, update } = makeConnector({});
    const gatePort = port({ name: "Sam", goals: ["code"], tools: [] });
    render(<GetStartedGate port={gatePort} zIndex={1} connector={Connector} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
    expect(connect).toHaveBeenCalledWith("linear");
    update({ connectedServices: new Set(["linear"]) });
    expect(within(screen.getByTestId("integration-card-linear")).getByText("✓ Connected")).toBeInTheDocument();
    for (const button of ["Next", "Next", "Next", "Finish"]) fireEvent.click(await screen.findByRole("button", { name: button }));
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(gatePort.saves.at(-1)).toMatchObject({ type: "complete", answers: { tools: ["linear"] } }));
  });

  it("lets the owner move on to another app while one sign-in is still pending", async () => {
    const { Connector, connect } = makeConnector({ connectingService: "github" });
    render(<GetStartedGate port={port({ goals: ["code"], tools: [] })} zIndex={1} connector={Connector} />);
    const linear = await screen.findByRole("button", { name: "Connect Linear" });
    expect(linear).toBeEnabled();
    fireEvent.click(linear);
    expect(connect).toHaveBeenCalledWith("linear");
  });

  it("explains a sign-in that did not finish and offers to try again", async () => {
    const { Connector, connect } = makeConnector({ failedServices: new Set(["linear"]) });
    render(<GetStartedGate port={port({ goals: ["code"], tools: [] })} zIndex={1} connector={Connector} />);
    expect(await screen.findByText("Sign-in didn't finish")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try connecting Linear again" }));
    expect(connect).toHaveBeenCalledWith("linear");
  });

  it("keeps saved tools when the connections have not loaded", async () => {
    const { Connector } = makeConnector({ connectionsLoaded: false });
    const gatePort = port({ step: 6, name: "Sam", goals: ["code"], tools: ["linear"] });
    render(<GetStartedGate port={gatePort} zIndex={1} connector={Connector} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(gatePort.saves.at(-1)).toMatchObject({ type: "complete", answers: { tools: ["linear"] } }));
  });

  it("explains when this computer cannot connect apps", async () => {
    const { Connector } = makeConnector({ unavailable: true });
    render(<GetStartedGate port={port({ goals: ["business"], tools: [] })} zIndex={1} connector={Connector} />);
    expect(await screen.findByText("You can connect apps later in Settings.")).toBeInTheDocument();
    expect(screen.queryByTestId("integrations-grid")).not.toBeInTheDocument();
  });

  it("has no connect list on the summary any more", async () => {
    const { Connector } = makeConnector({});
    render(<GetStartedGate port={port({ step: 6, name: "Sam", goals: ["code"], tools: [] })} zIndex={1} connector={Connector} />);
    expect(await screen.findByRole("heading", { name: "All set, Sam." })).toBeInTheDocument();
    expect(screen.queryByTestId("integrations-grid")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Connect your tools" })).not.toBeInTheDocument();
  });
});

describe("useGetStartedConnectFailures", () => {
  it("tracks failed services from the shared connect events", () => {
    const { result } = renderHook(() => useGetStartedConnectFailures());
    act(() => result.current.onEvent({ type: "connect.failed", service: "github" }));
    act(() => result.current.onEvent({ type: "connect.unavailable", service: "slack" }));
    expect([...result.current.failedServices]).toEqual(["github", "slack"]);
    act(() => result.current.onEvent({ type: "connect.succeeded", service: "github" }));
    act(() => result.current.clear("slack"));
    expect(result.current.failedServices.size).toBe(0);
  });
});

describe("useGetStartedConnect", () => {
  it("derives available and active services, and clears a failure before retrying", () => {
    const connectApp = vi.fn();
    const { result } = renderHook(() => {
      const failures = useGetStartedConnectFailures();
      const connect = useGetStartedConnect({
        failures,
        available: [{ id: "github", name: "GitHub", category: "dev" }],
        connections: [
          { id: "1", service: "gmail", accountLabel: "a", accountEmail: null, status: "active", connectedAt: AT },
          { id: "2", service: "slack", accountLabel: "b", accountEmail: null, status: "pending", connectedAt: AT },
        ],
        connectingService: null,
        connectionsLoaded: true,
        appsUnavailable: false,
        connectApp,
      });
      return { failures, connect };
    });
    expect([...result.current.connect.availableServices]).toEqual(["github"]);
    expect(result.current.connect.catalog).toEqual([{ id: "github", name: "GitHub", category: "dev" }]);
    expect(result.current.connect.connectionsLoaded).toBe(true);
    expect([...result.current.connect.connectedServices]).toEqual(["gmail"]);
    act(() => result.current.failures.onEvent({ type: "connect.failed", service: "github" }));
    expect(result.current.connect.failedServices.has("github")).toBe(true);
    act(() => result.current.connect.connect("github"));
    expect(connectApp).toHaveBeenCalledWith("github");
    expect(result.current.connect.failedServices.has("github")).toBe(false);
  });
});
