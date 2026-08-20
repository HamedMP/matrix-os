// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopUpdateButton from "../../desktop/src/renderer/src/features/updates/DesktopUpdateButton";
import DesktopUpdateExperience from "../../desktop/src/renderer/src/features/updates/DesktopUpdateExperience";
import ManualUpdateDialog from "../../desktop/src/renderer/src/features/updates/ManualUpdateDialog";
import WhatsNewDialog from "../../desktop/src/renderer/src/features/updates/WhatsNewDialog";
import { useDesktopUpdate } from "../../desktop/src/renderer/src/stores/desktop-update";

describe("desktop update experience", () => {
  beforeEach(() => {
    useDesktopUpdate.setState({
      snapshot: { status: "disabled" },
      release: null,
      whatsNewOpen: false,
      manualDialogOpen: false,
      installing: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("subscribes to background update state without acknowledging before dismissal", async () => {
    let updateListener: ((payload: unknown) => void) | null = null;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "update:get-state") return { status: "downloading", version: "1.2.3", progress: 48 };
      if (channel === "update:get-whats-new") {
        return {
          release: {
            version: "1.2.2",
            releaseDate: "2026-08-11T09:00:00.000Z",
            notes: "## Improved\n\n- Faster project loading",
          },
          shouldOpen: true,
        };
      }
      return { ok: true };
    });
    const unsubscribe = vi.fn();
    vi.stubGlobal("operator", {
      invoke,
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        if (channel === "update:state-changed") updateListener = listener;
        return unsubscribe;
      }),
    });

    const dispose = useDesktopUpdate.getState().initialize();

    await waitFor(() => {
      expect(useDesktopUpdate.getState().whatsNewOpen).toBe(true);
    });
    expect(invoke).not.toHaveBeenCalledWith("update:acknowledge-whats-new", { version: "1.2.2" });

    act(() => {
      updateListener?.({
        status: "ready",
        version: "1.2.3",
        progress: 100,
        release: { version: "1.2.3", notes: "## Improved\n\n- Faster updates" },
      });
    });
    expect(useDesktopUpdate.getState().snapshot).toEqual({
      status: "ready",
      version: "1.2.3",
      progress: 100,
      release: { version: "1.2.3", notes: "## Improved\n\n- Faster updates" },
    });

    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("shows manual check progress and offers restart-and-install with the changelog", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "update:get-state") return { status: "disabled" };
      if (channel === "update:get-whats-new") return { release: null, shouldOpen: false };
      return { ok: true };
    });
    vi.stubGlobal("operator", {
      invoke,
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      }),
    });

    render(
      <Tooltip.Provider>
        <DesktopUpdateExperience />
      </Tooltip.Provider>,
    );

    await waitFor(() => {
      expect(listeners.has("update:manual-check-requested")).toBe(true);
    });
    act(() => {
      listeners.get("update:manual-check-requested")?.({});
    });
    expect(screen.getByRole("dialog", { name: "Software Update" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Checking for updates…" })).toBeTruthy();

    act(() => {
      listeners.get("update:state-changed")?.({
        status: "downloading",
        version: "1.3.0",
        progress: 64,
      });
    });
    expect(screen.getByRole("heading", { name: "Downloading Matrix OS 1.3.0" })).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Download progress" }).getAttribute("aria-valuenow"),
    ).toBe("64");

    act(() => {
      listeners.get("update:state-changed")?.({
        status: "ready",
        version: "1.3.0",
        progress: 100,
        release: {
          version: "1.3.0",
          releaseDate: "2026-08-20T08:00:00.000Z",
          notes: "## Improved\n\n- Faster startup\n- Clearer update feedback",
        },
      });
    });
    expect(screen.getByRole("heading", { name: "Matrix OS 1.3.0 is ready" })).toBeTruthy();
    expect(screen.getByText("Faster startup")).toBeTruthy();
    expect(screen.getByText("Clearer update feedback")).toBeTruthy();

    const installButton = screen.getByRole("button", { name: "Restart & Install" });
    expect(installButton.style.background).toBe("var(--update-action)");
    fireEvent.click(installButton);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update:install", {});
    });

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog", { name: "Software Update" })).toBeNull();
  });

  it("lets a failed manual check retry through the trusted updater IPC", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "update:check") return { status: "checking" };
      return { ok: true };
    });
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: { status: "error" },
      manualDialogOpen: true,
    });

    render(
      <Tooltip.Provider>
        <ManualUpdateDialog />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("heading", { name: "Unable to check for updates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update:check", {});
      expect(useDesktopUpdate.getState().snapshot).toEqual({ status: "checking" });
    });
  });

  it("logs only the diagnostic error kind when a manual update check fails", async () => {
    const failure = new Error("private updater detail at /home/matrix");
    failure.name = "UpdaterIpcError";
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "update:check") throw failure;
      return { ok: true };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("operator", { invoke, on: vi.fn() });

    await useDesktopUpdate.getState().check();

    expect(useDesktopUpdate.getState().snapshot).toEqual({ status: "error" });
    expect(warn).toHaveBeenCalledWith(
      "[desktop-update] update check failed:",
      "UpdaterIpcError",
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("/home/matrix"),
    );
  });

  it("offers Retry and Close when updates are unavailable in a preview", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "update:check") return { status: "disabled" };
      return { ok: true };
    });
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: { status: "disabled" },
      manualDialogOpen: true,
    });

    render(
      <Tooltip.Provider>
        <ManualUpdateDialog />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Software Update" })).toBeNull();
  });

  it("confirms when Matrix OS is already up to date", () => {
    vi.stubGlobal("operator", { invoke: vi.fn(), on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: { status: "up-to-date" },
      manualDialogOpen: true,
    });

    render(
      <Tooltip.Provider>
        <ManualUpdateDialog />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("heading", { name: "Matrix OS is up to date" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("queues What's New behind an active manual update dialog", async () => {
    const release = {
      version: "1.3.0",
      notes: "## Improved\n\n- Faster startup",
    };
    const listeners = new Map<string, (payload: unknown) => void>();
    vi.stubGlobal("operator", {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "update:get-state") {
          return { status: "ready", version: "1.3.0", progress: 100, release };
        }
        if (channel === "update:get-whats-new") return { release, shouldOpen: true };
        return { ok: true };
      }),
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      }),
    });

    render(
      <Tooltip.Provider>
        <DesktopUpdateExperience />
      </Tooltip.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "What's New" })).toBeTruthy();
      expect(listeners.has("update:manual-check-requested")).toBe(true);
    });

    act(() => {
      listeners.get("update:manual-check-requested")?.({});
    });
    expect(screen.getByRole("dialog", { name: "Software Update" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "What's New" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.getByRole("dialog", { name: "What's New" })).toBeTruthy();
  });

  it("shows a blue Update control only when the download is ready and installs immediately", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: {
        status: "ready",
        version: "1.2.3",
        progress: 100,
        release: { version: "1.2.3", notes: "## Improved\n\n- Faster updates" },
      },
    });

    const view = render(
      <Tooltip.Provider>
        <DesktopUpdateButton collapsed={false} />
      </Tooltip.Provider>,
    );

    const button = screen.getByRole("button", { name: "Update Matrix OS to 1.2.3" });
    expect(button.style.background).toBe("var(--update-action)");
    fireEvent.click(button);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update:install", {});
    });

    view.unmount();
    useDesktopUpdate.setState({ snapshot: { status: "downloading", version: "1.2.4", progress: 99 } });
    render(
      <Tooltip.Provider>
        <DesktopUpdateButton collapsed={false} />
      </Tooltip.Provider>,
    );
    expect(screen.queryByRole("button", { name: /Update Matrix OS/ })).toBeNull();
  });

  it("renders a compact icon-only update control in expanded and collapsed sidebars", () => {
    vi.stubGlobal("operator", { invoke: vi.fn(), on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: {
        status: "ready",
        version: "1.2.3",
        progress: 100,
        release: { version: "1.2.3", notes: "## Improved\n\n- Faster updates" },
      },
    });

    const view = render(
      <Tooltip.Provider>
        <DesktopUpdateButton collapsed={false} />
      </Tooltip.Provider>,
    );

    const expandedButton = screen.getByRole("button", {
      name: "Update Matrix OS to 1.2.3",
    });
    expect(expandedButton.getAttribute("title")).toBe("Update Matrix OS to 1.2.3");
    expect(screen.queryByText("Update")).toBeNull();
    expect(screen.queryByText("v1.2.3")).toBeNull();

    view.rerender(
      <Tooltip.Provider>
        <DesktopUpdateButton collapsed />
      </Tooltip.Provider>,
    );

    const collapsedButton = screen.getByRole("button", {
      name: "Update Matrix OS to 1.2.3",
    });
    expect(collapsedButton.getAttribute("title")).toBe("Update Matrix OS to 1.2.3");
    expect(screen.queryByText("Update")).toBeNull();
    expect(screen.queryByText("v1.2.3")).toBeNull();
  });

  it("renders the installed version changelog and acknowledges it on dismissal", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      release: {
        version: "1.2.3",
        releaseDate: "2026-08-11T09:00:00.000Z",
        notes: "## Improved\n\n- Faster project loading\n- Clearer update status",
      },
      whatsNewOpen: true,
    });

    render(
      <Tooltip.Provider>
        <WhatsNewDialog />
      </Tooltip.Provider>,
    );

    const dialog = screen.getByRole("dialog", { name: "What's New" });
    expect(dialog.style.top).toBe("8vh");
    expect(dialog.style.maxWidth).toBe("calc(100vw - 32px)");
    expect(dialog.className).toContain("-translate-x-1/2");
    expect(screen.getByRole("heading", { name: "What's New", level: 1 })).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Latest")).toBeTruthy();
    expect(screen.getByText("Faster project loading")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close What's New" }));

    expect(useDesktopUpdate.getState().whatsNewOpen).toBe(false);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update:acknowledge-whats-new", { version: "1.2.3" });
    });
  });

  it("never renders remote release-note images and opens only HTTPS links", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      release: {
        version: "1.2.3",
        notes: [
          "![tracking pixel](https://tracker.example/pixel.png)",
          "[Secure notes](https://matrix-os.com/releases/1.2.3)",
          "[Insecure notes](http://example.com/releases/1.2.3)",
        ].join("\n\n"),
      },
      whatsNewOpen: true,
    });

    render(
      <Tooltip.Provider>
        <WhatsNewDialog />
      </Tooltip.Provider>,
    );

    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Secure notes" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("shell:open-external", {
        url: "https://matrix-os.com/releases/1.2.3",
      });
    });

    invoke.mockClear();
    fireEvent.click(screen.getByText("Insecure notes"));
    expect(invoke).not.toHaveBeenCalled();
  });
});
