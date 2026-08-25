// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useProjectLifecycle } from "../../desktop/src/renderer/src/stores/project-lifecycle";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

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
        if (channel === "companion:get-preferences") {
          return Promise.resolve({
            preferences: { rabbitEnabled: true, notchEnabled: false },
            supportsNotch: true,
          });
        }
        if (channel === "companion:set-preferences") return Promise.resolve({ ok: true });
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
  });

  it("opens the requested section and consumes the deep-link request", async () => {
    useUi.getState().requestSettingsSection("agent");

    render(<SettingsView />);

    // The unified Agent section renders instead of the default Account.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Agent" })).not.toBeNull());
    expect(useUi.getState().requestedSettingsSection).toBeNull();
  });

  it("keeps the selected navigation highlight in sync with the visible section", () => {
    render(<SettingsView />);
    const providers = screen.getByRole("button", { name: "Providers" });
    const integrations = screen.getByRole("button", { name: "Integrations" });

    fireEvent.click(providers);
    expect(providers.className).toContain("bg-[var(--bg-selected)]");

    fireEvent.click(integrations);
    expect(integrations.className).toContain("bg-[var(--bg-selected)]");
    expect(providers.className).not.toContain("bg-[var(--bg-selected)]");
  });

  it("configures the floating rabbit and macOS notch hosts from Settings", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Companion" }));

    expect(await screen.findByRole("heading", { name: "Companion" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Floating rabbit" }) as HTMLInputElement).checked).toBe(true);
    const notch = screen.getByRole("checkbox", { name: "MacBook notch" }) as HTMLInputElement;
    expect(notch.checked).toBe(false);
    fireEvent.click(notch);

    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith(
      "companion:set-preferences",
      { preferences: { rabbitEnabled: true, notchEnabled: true } },
    ));
  });

  it("ignores unknown requested sections", async () => {
    useUi.getState().requestSettingsSection("not-a-section");

    render(<SettingsView />);

    await waitFor(() => expect(useUi.getState().requestedSettingsSection).toBeNull());
    expect(screen.getByRole("heading", { name: "Account" })).not.toBeNull();
  });

  it("manages archived projects from the Machine settings group", async () => {
    const post = vi.fn(async () => ({ ok: true, action: "restore" }));
    const api = {
      baseUrl: "https://x.test",
      get: vi.fn(async (path: string) => path.includes("visibility=archived")
        ? { projects: [{
            slug: "customer-app",
            name: "Customer app",
            kind: "folder",
            archivedAt: "2026-08-06T13:00:00.000Z",
          }] }
        : { projects: [] }),
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getText: vi.fn(),
      getBlob: vi.fn(),
      putText: vi.fn(),
    } as ApiClient;
    useConnection.setState({ api });

    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Archived projects" })).not.toBeNull());
    expect(screen.getByText("Customer app")).not.toBeNull();
    expect(screen.getByText(/Connected folder/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore Customer app" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/customer-app/actions", { type: "restore" }));
  });
});
