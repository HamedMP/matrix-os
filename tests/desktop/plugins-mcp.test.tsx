// @vitest-environment jsdom

// Component tests for the desktop Plugins hub MCP servers section. No gateway
// route lists MCP servers today (kernel wires mcpServers internally in
// packages/kernel/src/options.ts), so the section is an HONEST empty state:
// it explains that MCP servers are configured on the Matrix computer and
// offers the canonical terminal path (workspace ensure + tab create + terminal
// tab, the same flow as provider setup terminals).
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServersSection } from "../../desktop/src/renderer/src/features/plugins";
import { AppError } from "../../desktop/src/shared/app-error";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ID = `tt_${"b".repeat(32)}`;

function makeApi(opts: { postError?: Error } = {}) {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async () => {
      throw new AppError("notFound");
    }),
    post: vi.fn(async (path: string) => {
      if (opts.postError) throw opts.postError;
      if (path === "/api/terminal/workspaces/ensure") return { workspace: { id: WORKSPACE_ID } };
      if (path === `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) return { tab: { id: TAB_ID } };
      throw new AppError("notFound");
    }),
    delete: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putText: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
  } as unknown as ApiClient;
}

describe("desktop plugins MCP servers section", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      api: makeApi() as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders an honest empty state explaining MCP servers are managed on the computer", () => {
    render(<McpServersSection />);
    expect(
      screen.getByText("MCP servers are configured on your Matrix computer"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /Open terminal/i })).not.toBeNull();
  });

  it("opens a terminal session so the user can manage MCP servers", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<McpServersSection />);

    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/terminal/workspaces/ensure", {}));
    expect(api.post).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`, {
        name: "plugins-mcp",
        cwd: "projects",
      });
    const tabs = useTabs.getState().tabs;
    expect(tabs.some((tab) => tab.kind === "terminal" && tab.sessionName === `${WORKSPACE_ID}:${TAB_ID}`)).toBe(true);
  });

  it("shows generic copy and does not open a tab when the session cannot be created", async () => {
    const api = makeApi({ postError: new AppError("server") });
    useConnection.setState({ api: api as never });
    render(<McpServersSection />);

    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).not.toBeNull(),
    );
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  it("shows the misconfigured copy when no computer is connected", async () => {
    useConnection.setState({ api: null as never });
    render(<McpServersSection />);

    fireEvent.click(screen.getByRole("button", { name: /Open terminal/i }));

    await waitFor(() =>
      expect(
        screen.getByText("No computer is connected. Select a runtime to continue."),
      ).not.toBeNull(),
    );
  });
});
