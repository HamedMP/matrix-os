// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopUpdateButton from "../../desktop/src/renderer/src/features/updates/DesktopUpdateButton";
import WhatsNewDialog from "../../desktop/src/renderer/src/features/updates/WhatsNewDialog";
import { useDesktopUpdate } from "../../desktop/src/renderer/src/stores/desktop-update";

describe("desktop update experience", () => {
  beforeEach(() => {
    useDesktopUpdate.setState({
      snapshot: { status: "disabled" },
      release: null,
      whatsNewOpen: false,
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
      updateListener?.({ status: "ready", version: "1.2.3", progress: 100 });
    });
    expect(useDesktopUpdate.getState().snapshot).toEqual({
      status: "ready",
      version: "1.2.3",
      progress: 100,
    });

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("shows a blue Update control only when the download is ready and installs immediately", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: { status: "ready", version: "1.2.3", progress: 100 },
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
      snapshot: { status: "ready", version: "1.2.3", progress: 100 },
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
