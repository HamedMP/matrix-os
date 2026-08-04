// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProvidersSection from "../../desktop/src/renderer/src/features/settings/sections/ProvidersSection";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

function runtimeSummary(providers: unknown[]) {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
    providers,
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-08T00:00:00.000Z",
  };
}

const CLAUDE_READY = {
  id: "claude",
  kind: "claude",
  displayName: "Claude Code",
  availability: "available",
  installStatus: "installed",
  authStatus: "authenticated",
  supportedModes: ["default"],
  defaultMode: "default",
  defaultModel: "sonnet",
  setupActions: [],
};

const CODEX_AUTH_REQUIRED = {
  id: "codex",
  kind: "codex",
  displayName: "Codex",
  availability: "auth_required",
  installStatus: "installed",
  authStatus: "missing",
  supportedModes: ["default"],
  defaultMode: "default",
  setupActions: [
    {
      id: "codex-auth",
      kind: "foreground_terminal",
      label: "Sign in",
      command: "codex login",
    },
  ],
};

describe("ProvidersSection", () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    getText: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    putText: ReturnType<typeof vi.fn>;
  };
  let summaryResult: () => Promise<unknown>;

  beforeEach(() => {
    summaryResult = () => Promise.resolve(runtimeSummary([CLAUDE_READY, CODEX_AUTH_REQUIRED]));
    api = {
      get: vi.fn(),
      getText: vi.fn(),
      post: vi.fn().mockResolvedValue({ name: "matrix-setup-codex" }),
      put: vi.fn(),
      putText: vi.fn(),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });
    useTabs.setState({
      activeTabId: "home",
      tabs: [{ id: "home", kind: "home", title: "Home", closable: false }],
    });
    useProviderPreferences.setState({ defaultProviderId: null, hydrated: false });
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "runtime:get-summary") return summaryResult();
        if (channel === "state:get") return Promise.resolve({ value: null });
        return Promise.resolve({ ok: true });
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads provider status on open and renders a card per provider", async () => {
    render(<ProvidersSection />);

    // Each provider name appears twice: in the Default provider <option> and
    // on the provider card title.
    expect((await screen.findAllByText("Claude Code")).length).toBe(2);
    expect(screen.getAllByText("Codex").length).toBe(2);
    expect(screen.getByText("Available · installed / authenticated")).toBeTruthy();
    expect(screen.getByText("Auth required · installed / missing")).toBeTruthy();
    expect(screen.getByText("Model: sonnet")).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-summary", {});
  });

  it("runs setup actions through the existing foreground terminal flow", async () => {
    render(<ProvidersSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open provider setup Sign in" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/terminal/sessions",
        expect.objectContaining({ cmd: "codex login", cwd: "projects" }),
      ),
    );
    expect(
      useTabs.getState().tabs.some((tab) => tab.kind === "terminal" && tab.title === "Sign in"),
    ).toBe(true);
  });

  it("shows a generic setup error when the terminal cannot be opened", async () => {
    api.post.mockRejectedValue(new Error("econnrefused /home/matrix/secret"));
    render(<ProvidersSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Open provider setup Sign in" }));

    expect(await screen.findByText("Could not open setup terminal. Try again from Terminal.")).toBeTruthy();
    expect(screen.queryByText(/econnrefused/)).toBeNull();
    expect(screen.queryByText(/\/home\/matrix/)).toBeNull();
  });

  it("shows a connect message instead of crashing when the runtime is disconnected", async () => {
    useConnection.setState({ status: "signed-out", api: null });
    render(<ProvidersSection />);

    expect(
      await screen.findByText("Connect to your Matrix computer to manage coding agent providers."),
    ).toBeTruthy();
    expect(window.operator.invoke).not.toHaveBeenCalledWith("runtime:get-summary", {});
  });

  it("shows a generic error with retry after a failed load, then recovers", async () => {
    let attempts = 0;
    summaryResult = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("postgres connection failed at /home/matrix/data"))
        : Promise.resolve(runtimeSummary([CLAUDE_READY]));
    };
    render(<ProvidersSection />);

    expect(await screen.findByText("Provider status is unavailable right now.")).toBeTruthy();
    expect(screen.queryByText(/postgres/)).toBeNull();
    expect(screen.queryByText(/\/home\/matrix/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Provider status is unavailable right now.")).toBeNull();
  });

  it("keeps stale providers visible when a manual refresh fails", async () => {
    render(<ProvidersSection />);
    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);

    summaryResult = () => Promise.reject(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" }));

    expect(await screen.findByText("Provider status is unavailable right now.")).toBeTruthy();
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  });

  it("refreshes provider status when the runtime slot changes", async () => {
    render(<ProvidersSection />);
    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);

    summaryResult = () => Promise.resolve(runtimeSummary([{ ...CLAUDE_READY, id: "claude", displayName: "Claude Code" }]));
    act(() => {
      useConnection.setState({ runtimeSlot: "secondary" });
    });

    await waitFor(() =>
      expect(
        (window.operator.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([channel]) => channel === "runtime:get-summary",
        ),
      ).toHaveLength(2),
    );
  });

  it("shows an empty state when no providers are configured", async () => {
    summaryResult = () => Promise.resolve(runtimeSummary([]));
    render(<ProvidersSection />);

    expect(
      await screen.findByText("No coding agent providers are configured on this computer yet."),
    ).toBeTruthy();
  });

  it("sets the default provider for new chats and marks the card", async () => {
    render(<ProvidersSection />);
    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Default provider" }), {
      target: { value: "codex" },
    });

    expect(useProviderPreferences.getState().defaultProviderId).toBe("codex");
    expect(window.operator.invoke).toHaveBeenCalledWith("state:set", {
      key: "providerPreferences",
      value: { defaultProviderId: "codex" },
    });
    expect(await screen.findByText("Default")).toBeTruthy();
  });

  it("resets the default provider back to automatic", async () => {
    useProviderPreferences.setState({ defaultProviderId: "codex", hydrated: true });
    render(<ProvidersSection />);
    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Default provider" }), {
      target: { value: "" },
    });

    expect(useProviderPreferences.getState().defaultProviderId).toBeNull();
    expect(screen.queryByText("Default")).toBeNull();
  });
});
