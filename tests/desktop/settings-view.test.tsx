// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useProjectLifecycle } from "../../desktop/src/renderer/src/stores/project-lifecycle";

describe("SettingsView", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "state:get") return Promise.resolve({ value: { theme: "light" } });
        return Promise.resolve({});
      }),
      on: vi.fn(() => () => undefined),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://x.test",
      runtimeSlot: "primary",
      api: null,
    });
    useProjectLifecycle.setState(useProjectLifecycle.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the section navigation", async () => {
    // Theme application lives in the appearance store (loaded at App boot),
    // not in SettingsView.
    render(<SettingsView />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Computers" })).not.toBeNull());
    expect(screen.getByRole("heading", { name: "Account" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Channels" })).toBeNull();
    expect(screen.getByRole("button", { name: "Agents & providers" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Identity & personality" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Providers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agent (Hermes)" })).toBeNull();
  });

  it.each(["agent", "providers"] as const)("maps the legacy %s deep link to Agents & providers and consumes it", async (legacySection) => {
    useUi.setState({ requestedSettingsSection: legacySection });

    render(<SettingsView />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Agents & providers" })).not.toBeNull());
    expect(useUi.getState().requestedSettingsSection).toBeNull();
  });

  it.each(["agent", "providers"] as const)("normalizes the legacy %s section at the request boundary", (legacySection) => {
    useUi.getState().requestSettingsSection(legacySection);

    expect(useUi.getState().requestedSettingsSection).toBe("agents-providers");
  });

  it("opens Identity & personality as a first-class section", async () => {
    useUi.getState().requestSettingsSection("identity-personality");

    render(<SettingsView />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Identity & personality" })).not.toBeNull());
    expect(useUi.getState().requestedSettingsSection).toBeNull();
  });

  it("keeps the selected navigation highlight in sync with the visible section", () => {
    render(<SettingsView />);
    const providers = screen.getByRole("button", { name: "Agents & providers" });
    const services = screen.getByRole("button", { name: "Services" });

    fireEvent.click(providers);
    expect(providers.className).toContain("bg-[var(--bg-selected)]");

    fireEvent.click(services);
    expect(services.className).toContain("bg-[var(--bg-selected)]");
    expect(providers.className).not.toContain("bg-[var(--bg-selected)]");
  });

  it("keeps the previous local Agents & providers settings surface", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Agents & providers" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Providers" })).not.toBeNull());
    expect(document.querySelector('[data-settings-adapter="agents-providers-legacy"]')).not.toBeNull();
    expect(document.querySelector('[data-provider-settings-adapter="legacy"]')).not.toBeNull();
    expect(screen.queryByText("HARNESSES")).toBeNull();
  });

  it("groups services, MCPs, skills, and CLI under Integrations", () => {
    render(<SettingsView />);
    const sidebar = screen.getByRole("navigation", { name: "Settings sections" });
    const integrationGroup = screen.getByText("Integrations");
    const machineGroup = screen.getByText("Machine");

    expect(integrationGroup).not.toBeNull();
    expect(integrationGroup.compareDocumentPosition(machineGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Services" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "MCPs" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Skills" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "CLI" })).not.toBeNull();
    expect(sidebar.textContent).not.toContain("Integration categories");
  });

  it("can render its section content without owning the sidebar navigation", async () => {
    const { default: SettingsView } = await import("../../desktop/src/renderer/src/features/settings/SettingsView");

    render(<SettingsView section="account" onSectionChange={() => {}} />);

    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Account" })).not.toBeNull();
  });

  it("ignores unknown requested sections", async () => {
    useUi.getState().requestSettingsSection("not-a-section");

    render(<SettingsView />);

    await waitFor(() => expect(useUi.getState().requestedSettingsSection).toBeNull());
    expect(screen.getByRole("heading", { name: "Account" })).not.toBeNull();
  });

});
