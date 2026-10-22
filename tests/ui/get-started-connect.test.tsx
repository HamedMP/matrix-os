// @vitest-environment jsdom
import React, { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  GetStartedGate,
  useGetStartedConnect,
  useGetStartedConnectFailures,
  type GetStartedConnect,
  type GetStartedPort,
} from "../../packages/ui/src/get-started/index.js";
import { GET_STARTED_WIZARD_STEPS } from "../../packages/contracts/src/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function port(draft: Record<string, unknown>): GetStartedPort {
  return {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 4, ...draft } })),
    save: vi.fn(async () => ({ status: "completed", completedAt: AT, answers: { goals: [], tools: [] } })),
  };
}

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

describe("Get started connect list", () => {
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

  it("lists the picked tools and two suggestions, without connecting anything by itself", async () => {
    const { Connector, connect } = makeConnector({});
    render(<GetStartedGate port={port({ name: "Sam", goals: ["code"], tools: ["github", "claude-code"] })} zIndex={1} connector={Connector} />);
    const list = await screen.findByRole("list", { name: "Connect your tools" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".mxo-app__name")?.firstChild?.textContent)).toEqual(["GitHub", "Claude Code"]);
    expect(rows[0]!.querySelector("img")).toHaveAttribute("src", "https://example.test/github.png");
    expect(within(rows[0]!).getByText("So your AI can work on your repos")).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Popular with developers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Figma" })).toBeInTheDocument();
    expect(screen.getByText("Optional. Each one opens the app's own sign-in. Anything you skip stays in Getting started.")).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects through the host and shows waiting, connected and failed states", async () => {
    const { Connector, connect, update } = makeConnector({});
    render(<GetStartedGate port={port({ goals: ["code"], tools: ["github"] })} zIndex={1} connector={Connector} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    expect(connect).toHaveBeenCalledWith("github");

    update({ connectingService: "github" });
    expect(screen.getByText("Waiting for GitHub sign-in…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Figma" })).toBeDisabled();

    update({ connectingService: null, failedServices: new Set(["github"]) });
    expect(screen.getByText("Sign-in didn't finish")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try connecting GitHub again" }));
    expect(connect).toHaveBeenLastCalledWith("github");

    update({ failedServices: new Set(), connectedServices: new Set(["github"]) });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it("explains when this computer cannot connect apps", async () => {
    const { Connector } = makeConnector({ unavailable: true, availableServices: new Set() });
    render(<GetStartedGate port={port({ goals: ["code"], tools: ["github"] })} zIndex={1} connector={Connector} />);
    expect(await screen.findByText("You can connect apps from Getting started once you're in.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect / })).not.toBeInTheDocument();
  });

  it("still lets the owner enter without connecting", async () => {
    const { Connector } = makeConnector({});
    const gatePort = port({ goals: ["code"], tools: ["github"] });
    render(<GetStartedGate port={gatePort} zIndex={1} connector={Connector}><div data-testid="widget" /></GetStartedGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    expect(await screen.findByTestId("widget")).toBeInTheDocument();
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
        appsUnavailable: false,
        connectApp,
      });
      return { failures, connect };
    });
    expect([...result.current.connect.availableServices]).toEqual(["github"]);
    expect([...result.current.connect.connectedServices]).toEqual(["gmail"]);
    act(() => result.current.failures.onEvent({ type: "connect.failed", service: "github" }));
    expect(result.current.connect.failedServices.has("github")).toBe(true);
    act(() => result.current.connect.connect("github"));
    expect(connectApp).toHaveBeenCalledWith("github");
    expect(result.current.connect.failedServices.has("github")).toBe(false);
  });
});
