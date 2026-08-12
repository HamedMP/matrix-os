// @vitest-environment jsdom

import type {
  ProviderUsageResponse,
  ProviderUsageSourceSummary,
  RuntimeSummary,
} from "@matrix-os/contracts";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProviderUsageMenu from "../../desktop/src/renderer/src/features/mission-control/ProviderUsageMenu";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useProviderUsage } from "../../desktop/src/renderer/src/stores/provider-usage";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const RUNTIME_SCOPE = "operator|https://platform.test|primary";

function usageSource(
  overrides: Partial<ProviderUsageSourceSummary> = {},
): ProviderUsageSourceSummary {
  return {
    id: "openai-chatgpt",
    displayName: "OpenAI / ChatGPT",
    linkedAgentProviderIds: ["codex"],
    state: "available",
    accuracy: "provider_reported",
    windows: [{
      id: "five-hour",
      label: "5-hour window",
      remainingPercent: 72,
      resetsAt: "2026-08-10T16:00:00.000Z",
      windowMinutes: 300,
    }],
    credits: { remaining: 12.5, unit: "USD" },
    observedAt: NOW.toISOString(),
    expiresAt: "2026-08-10T12:05:00.000Z",
    setupActions: [],
    ...overrides,
  };
}

function response(
  usageSources: ProviderUsageSourceSummary[] = [usageSource()],
): ProviderUsageResponse {
  return { usageSources, serverTime: NOW.toISOString() };
}

function summary(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsUsageSummary", enabled: true }],
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        kind: "codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
      {
        id: "claude",
        displayName: "Claude Code",
        kind: "claude",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
    ],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 24_000,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8_192,
      maxListItems: 20,
    },
    serverTime: NOW.toISOString(),
  };
}

function renderUsageMenu({
  collapsed = false,
  usageResponse = response(),
  usageStatus = "ready" as const,
}: {
  collapsed?: boolean;
  usageResponse?: ProviderUsageResponse | null;
  usageStatus?: "idle" | "loading" | "ready" | "refreshing" | "error";
} = {}) {
  useProviderUsage.setState({
    status: usageStatus,
    response: usageResponse,
    runtimeScope: RUNTIME_SCOPE,
    error: usageStatus === "error" ? "Provider usage is temporarily unavailable." : null,
  });
  return render(<ProviderUsageMenu collapsed={collapsed} />);
}

describe("ProviderUsageMenu", () => {
  beforeEach(() => {
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        post: vi.fn(async () => ({ name: "matrix-setup-codex" })),
      } as never,
    });
    useCodingAgentWorkspace.setState({
      summary: summary(),
      activeThreadId: null,
      runtimeScope: RUNTIME_SCOPE,
    });
    useProviderPreferences.setState({ defaultProviderId: "codex", hydrated: true });
    useTabs.setState({
      activeTabId: "home",
      tabs: [{ id: "home", kind: "home", title: "Home", closable: false }],
    });
    useUi.setState(useUi.getInitialState(), true);
    useProviderUsage.getState().clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the selected provider and exact remaining amount in the expanded sidebar", () => {
    renderUsageMenu();

    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("72% left")).toBeTruthy();
  });

  it("uses the most constrained quota window for the compact row", () => {
    renderUsageMenu({
      usageResponse: response([usageSource({
        windows: [
          { id: "five-hour", label: "5-hour window", remainingPercent: 72, resetsAt: "2026-08-10T16:00:00.000Z", windowMinutes: 300 },
          { id: "seven-day", label: "7-day window", remainingPercent: 41, resetsAt: "2026-08-16T12:00:00.000Z", windowMinutes: 10_080 },
        ],
      })]),
    });

    expect(screen.getByText("41% left")).toBeTruthy();
  });

  it("shows all sources, windows, resets, credits, and freshness in the popover", async () => {
    const anthropic = usageSource({
      id: "anthropic",
      displayName: "Anthropic",
      linkedAgentProviderIds: ["claude"],
      windows: [{ id: "weekly", label: "Weekly", remainingPercent: 63, resetsAt: "2026-08-13T12:00:00.000Z" }],
      credits: undefined,
    });
    renderUsageMenu({
      usageResponse: response([
        usageSource({
          windows: [
            { id: "five-hour", label: "5-hour window", remainingPercent: 72, resetsAt: "2026-08-10T16:00:00.000Z" },
            { id: "seven-day", label: "7-day window", remainingPercent: 41, resetsAt: "2026-08-16T12:00:00.000Z" },
          ],
        }),
        anthropic,
      ]),
    });

    fireEvent.click(screen.getByRole("button", { name: /Codex, 41% left/i }));

    expect(await screen.findByRole("dialog", { name: "Provider usage" })).toBeTruthy();
    expect(screen.getByText("OpenAI / ChatGPT")).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("5-hour window")).toBeTruthy();
    expect(screen.getByText("7-day window")).toBeTruthy();
    expect(screen.getByText("Resets in 4 hours")).toBeTruthy();
    expect(screen.getByText("$12.50 remaining")).toBeTruthy();
    expect(screen.getAllByText(/Updated just now/).length).toBeGreaterThan(0);
  });

  it("marks the provider popover as a renderer overlay until it closes", async () => {
    renderUsageMenu();

    fireEvent.click(screen.getByRole("button", { name: /Codex, 72% left/i }));
    await screen.findByRole("dialog", { name: "Provider usage" });
    expect(useUi.getState()).toMatchObject({ providerUsageOpen: true });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(useUi.getState()).toMatchObject({ providerUsageOpen: false });
    });
  });

  it("keeps collapsed mode compact while exposing complete usage context", () => {
    renderUsageMenu({
      collapsed: true,
      usageResponse: response([usageSource({
        windows: [{ id: "five-hour", label: "5-hour window", remainingPercent: 72, resetsAt: "2026-08-10T16:00:00.000Z" }],
      })]),
    });

    const trigger = screen.getByRole("button", {
      name: /Codex, 72% left, resets in 4 hours, updated just now/i,
    });
    expect(trigger).toBeTruthy();
    expect(screen.queryByText("72% left")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("72");
  });

  it.each([
    { remaining: 20, tone: "warning", color: "var(--warning)" },
    { remaining: 9, tone: "danger", color: "var(--danger)" },
  ])("uses the $tone token at $remaining%", ({ remaining, tone, color }) => {
    renderUsageMenu({
      usageResponse: response([usageSource({
        windows: [{ id: "primary", label: "Primary", remainingPercent: remaining }],
      })]),
    });

    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("data-tone")).toBe(tone);
    expect(progress.style.color).toBe(color);
  });

  it.each([
    { state: "unsupported" as const, copy: "Usage not reported" },
    { state: "setup_required" as const, copy: "Setup required" },
    { state: "unavailable" as const, copy: "Temporarily unavailable" },
  ])("renders truthful $state copy without a percentage", ({ state, copy }) => {
    renderUsageMenu({
      usageResponse: response([usageSource({
        state,
        accuracy: undefined,
        windows: [],
        credits: undefined,
        observedAt: undefined,
        expiresAt: undefined,
      })]),
    });

    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByText(/% left/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("labels last-known data as stale instead of presenting it as current", async () => {
    renderUsageMenu({
      usageResponse: response([usageSource({ state: "stale" })]),
    });

    expect(screen.getByText("72% left · Last known")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Codex, 72% left/i }));
    expect(await screen.findByText("Last known")).toBeTruthy();
  });

  it("marks retained data as last known when the desktop refresh itself fails", async () => {
    renderUsageMenu({ usageResponse: response(), usageStatus: "error" });

    expect(screen.getByText("72% left · Last known")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Codex, 72% left/i }));
    expect(await screen.findByText("Last known")).toBeTruthy();
  });

  it.each([
    { usageStatus: "loading" as const, copy: "Checking usage…" },
    { usageStatus: "error" as const, copy: "Usage temporarily unavailable" },
  ])("renders the $usageStatus store state without fake progress", ({ usageStatus, copy }) => {
    renderUsageMenu({ usageResponse: null, usageStatus });

    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByText(/% left/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("forces a refresh without changing the default provider", async () => {
    const refresh = vi.fn(async () => undefined);
    useProviderUsage.setState({ refresh });
    renderUsageMenu();

    fireEvent.click(screen.getByRole("button", { name: /Codex, 72% left/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh usage" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ force: true }));
    expect(useProviderPreferences.getState().defaultProviderId).toBe("codex");
  });

  it("opens a setup-required source in the existing foreground terminal flow", async () => {
    const api = useConnection.getState().api!;
    renderUsageMenu({
      usageResponse: response([usageSource({
        state: "setup_required",
        accuracy: undefined,
        windows: [],
        credits: undefined,
        observedAt: undefined,
        expiresAt: undefined,
        setupActions: [{
          id: "codex-auth",
          kind: "foreground_terminal",
          label: "Sign in to Codex",
          command: "codex login",
        }],
      })]),
    });

    fireEvent.click(screen.getByRole("button", { name: /Codex, Setup required/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/terminal/sessions",
      expect.objectContaining({ cmd: "codex login", cwd: "projects" }),
    ));
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminal" && tab.title === "Sign in to Codex")).toBe(true);
  });
});
