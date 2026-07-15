// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

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
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("applies the persisted theme to the document on mount", async () => {
    render(<SettingsView />);

    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(window.operator.invoke).toHaveBeenCalledWith("state:get", { key: "appearance" });
    expect(screen.getByRole("button", { name: "Computers" })).not.toBeNull();
  });

  it("opens the requested section and consumes the deep-link request", async () => {
    useUi.getState().requestSettingsSection("agent");

    render(<SettingsView />);

    // The Agent (Hermes) section renders instead of the default Account.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Agent (Hermes)" })).not.toBeNull());
    expect(useUi.getState().requestedSettingsSection).toBeNull();
  });

  it("ignores unknown requested sections", async () => {
    useUi.getState().requestSettingsSection("not-a-section");

    render(<SettingsView />);

    await waitFor(() => expect(useUi.getState().requestedSettingsSection).toBeNull());
    expect(screen.getByRole("heading", { name: "Account" })).not.toBeNull();
  });
});
