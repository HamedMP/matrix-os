// @vitest-environment jsdom

// Tests for the desktop Plugins hub page: section nav (Integrations / MCP
// servers / Skills / CLI), the sidebar "Plugins" entry that opens a plugins
// tab, and TabContent routing for the plugins tab kind. The Integrations
// section is the promoted IntegrationsSettingsSection imported from
// features/integrations — the same component Settings uses.
import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PluginsHub from "../../desktop/src/renderer/src/features/plugins";
import { usePlugins } from "../../desktop/src/renderer/src/features/plugins";
import { useIntegrations } from "../../desktop/src/renderer/src/features/integrations";
import Sidebar from "../../desktop/src/renderer/src/features/mission-control/Sidebar";
import TabContent from "../../desktop/src/renderer/src/features/mission-control/TabContent";
import { AppError } from "../../desktop/src/shared/app-error";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

function makeApi() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === "/api/integrations/available") {
        return [{ id: "gmail", name: "Gmail", category: "google", icon: "mail", actions: {} }];
      }
      if (path === "/api/integrations") return [];
      if (path === "/api/settings/skills") {
        return [{ name: "code-review", file: ".agents/skills/code-review/SKILL.md", enabled: true }];
      }
      throw new AppError("notFound");
    }),
    post: vi.fn(async () => {
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

describe("desktop plugins hub", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
    useIntegrations.setState(useIntegrations.getInitialState(), true);
    usePlugins.setState(usePlugins.getInitialState(), true);
    useTabs.setState({ tabs: [], activeTabId: null });
    useThreads.setState({ threads: [], activeThreadId: null });
    useBoard.setState({ projects: [] });
    useUi.setState({ sidebarCollapsed: false });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      displayName: null,
      imageUrl: null,
      platformHost: "https://platform.test",
      api: makeApi() as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the section nav and loads Integrations as the default section", async () => {
    render(<PluginsHub />);
    expect(screen.getByRole("button", { name: /Integrations/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /MCP servers/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Skills/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /CLI/i })).not.toBeNull();

    // Default section is the promoted integrations experience.
    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());
  });

  it("switches to the Skills section and lists installed skills", async () => {
    render(<PluginsHub />);
    fireEvent.click(screen.getByRole("button", { name: /Skills/i }));
    await waitFor(() => expect(screen.getByText("code-review")).not.toBeNull());
  });

  it("switches to the MCP servers section with its honest empty state", async () => {
    render(<PluginsHub />);
    fireEvent.click(screen.getByRole("button", { name: /MCP servers/i }));
    await waitFor(() =>
      expect(
        screen.getByText("MCP servers are configured on your Matrix computer"),
      ).not.toBeNull(),
    );
  });

  it("switches to the CLI section with the install commands", async () => {
    render(<PluginsHub />);
    fireEvent.click(screen.getByRole("button", { name: /CLI/i }));
    await waitFor(() =>
      expect(screen.getByText("brew install finnaai/tap/matrix")).not.toBeNull(),
    );
  });

  it("opens a plugins tab from the sidebar entry", () => {
    render(
      <Tooltip.Provider>
        <Sidebar />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Plugins/i }));
    const { tabs, activeTabId } = useTabs.getState();
    const pluginsTab = tabs.find((tab) => tab.kind === "plugins");
    expect(pluginsTab).toBeDefined();
    expect(pluginsTab?.title).toBe("Plugins");
    expect(activeTabId).toBe(pluginsTab?.id);
  });

  it("renders the hub for a plugins tab in TabContent", async () => {
    useTabs.setState({
      tabs: [{ id: "tab-1", kind: "plugins", title: "Plugins", closable: true }],
      activeTabId: "tab-1",
    });
    render(<TabContent />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /MCP servers/i })).not.toBeNull(),
    );
  });
});
