// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  return {
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
    expect(api.get).toHaveBeenCalledTimes(6);
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(18));
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

    const githubRow = screen.getByRole("button", { name: "Connect GitHub" });
    expect(githubRow.className).toContain("gap-3");
    expect(githubRow.className).toContain("py-2");
    expect(githubRow.querySelector(":scope > svg:last-child")?.getAttribute("width")).toBe("16");
    expect(screen.getByRole("button", { name: "Set up billing" })
      .querySelector("img")?.getAttribute("width")).toBe("12");
    expect(screen.getByRole("button", { name: "Log in to Codex / Claude" })).not.toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(12));
  });

  it("opens the relevant setup surface without closing the popover", async () => {
    render(<GettingStartedPopover />);
    const api = useConnection.getState().api!;
    fireEvent.click(await screen.findByRole("button", { name: "Getting started — 3 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect email & calendar" }));

    expect(useUi.getState().requestedSettingsSection).toBe("services");
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "settings", title: "Settings" }),
    ]);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(12));
  });
});
