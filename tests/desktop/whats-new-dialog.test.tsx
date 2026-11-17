// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WhatsNewDialog from "../../desktop/src/renderer/src/features/updates/WhatsNewDialog";
import { buildReleaseNotesCatalog } from "../../desktop/src/renderer/src/features/updates/release-notes-catalog";
import { whatsNewPreviewRequested } from "../../desktop/src/renderer/src/features/updates/whats-new-preview";
import { openWhatsNew, useDesktopUpdate } from "../../desktop/src/renderer/src/stores/desktop-update";

const catalog = buildReleaseNotesCatalog(
  {
    "/r/0.1.24.json": {
      version: "0.1.24",
      channel: "canary",
      date: "2026-11-16",
      title: "Your agents, at a glance",
      shortTitle: "Agents everywhere",
      summary: "See which coding agents are running, done or waiting on you.",
      highlights: [
        {
          tag: "Highlight",
          title: "Agent status everywhere",
          body: "Agents now report when they are working.",
          surfaces: ["web-desktop", "electron-desktop"],
          art: "agents",
          tone: "lime",
        },
      ],
      items: [
        { kind: "new", text: "Set up GitHub from Settings on mobile." },
        { kind: "improved", text: "Agents can be grouped." },
        { kind: "fixed", text: "Shared chats stay available." },
      ],
      hidden: [3386],
    },
    "/r/0.1.23.json": {
      version: "0.1.23",
      channel: "stable",
      date: "2026-11-09",
      title: "Messaging comes home",
      shortTitle: "WhatsApp + Matrix AI",
      summary: "Connect WhatsApp from Settings.",
      highlights: [],
      items: [{ kind: "new", text: "WhatsApp settings." }],
    },
  },
  vi.fn(),
);

function renderDialog() {
  return render(
    <Tooltip.Provider>
      <WhatsNewDialog catalog={catalog} />
    </Tooltip.Provider>,
  );
}

describe("What's New dialog", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("operator", { invoke, on: vi.fn() });
    useDesktopUpdate.setState({
      snapshot: { status: "disabled" },
      release: null,
      whatsNewOpen: false,
      buildChannel: null,
      manualDialogOpen: false,
      installing: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders structured notes for the version that was just installed", () => {
    useDesktopUpdate.setState({
      release: { version: "0.1.24", releaseDate: "2026-11-16T09:00:00.000Z", notes: "## raw" },
      whatsNewOpen: true,
    });
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "What's New" });
    expect(within(dialog).getByText("Updated to 0.1.24 · November 16, 2026")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Your agents, at a glance" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Agent status everywhere" })).toBeTruthy();
    expect(within(dialog).getByText("Web Desktop")).toBeTruthy();
    expect(within(dialog).getByText("Desktop app")).toBeTruthy();
    const items = within(within(dialog).getByRole("region", { name: "Also in this release" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "NewSet up GitHub from Settings on mobile.",
      "ImprovedAgents can be grouped.",
      "FixedShared chats stay available.",
    ]);
    expect(within(dialog).queryByText("## raw")).toBeNull();
    expect(within(dialog).queryByText("3386")).toBeNull();
    expect(within(dialog).getByText("Canary channel")).toBeTruthy();
    const art = dialog.querySelector('[data-highlight-art="agents"]');
    expect(art?.getAttribute("data-tone")).toBe("lime");
    expect(art?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("lists every release newest first and switches when one is picked", () => {
    useDesktopUpdate.setState({ whatsNewOpen: true });
    renderDialog();

    const rail = screen.getByRole("navigation", { name: "Releases" });
    const buttons = within(rail).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "0.1.24CanaryNov 16 · Agents everywhere",
      "0.1.23StableNov 9 · WhatsApp + Matrix AI",
    ]);
    expect(buttons[0]?.getAttribute("aria-current")).toBe("true");

    fireEvent.click(buttons[1]!);
    expect(screen.getByRole("heading", { name: "Messaging comes home" })).toBeTruthy();
    expect(screen.getByText("Released November 9, 2026")).toBeTruthy();
    expect(buttons[1]?.getAttribute("aria-current")).toBe("true");
  });

  it("shows the update's markdown notes when its version has no structured notes", () => {
    useDesktopUpdate.setState({
      release: { version: "0.1.25", releaseDate: "2026-11-23T09:00:00.000Z", notes: "- Faster project loading" },
      whatsNewOpen: true,
    });
    renderDialog();

    expect(screen.getByText("Updated to 0.1.25 · November 23, 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Matrix OS 0.1.25" })).toBeTruthy();
    expect(screen.getByText("Faster project loading")).toBeTruthy();
  });

  it("opens the technical notes on GitHub and acknowledges on Got it", async () => {
    useDesktopUpdate.setState({
      release: { version: "0.1.24", notes: "" },
      whatsNewOpen: true,
    });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Technical release notes ↗" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("shell:open-external", {
        url: "https://github.com/HamedMP/matrix-os/releases/tag/desktop-v0.1.24",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(useDesktopUpdate.getState().whatsNewOpen).toBe(false);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update:acknowledge-whats-new", { version: "0.1.24" });
    });
  });

  it("links a channel entry without a build stamp to the channel's releases", async () => {
    const channelCatalog = buildReleaseNotesCatalog(
      { "/r/0.1.24-canary.json": { ...catalog[0], version: "0.1.24-canary" } },
      vi.fn(),
    );
    useDesktopUpdate.setState({ release: null, whatsNewOpen: true });
    render(
      <Tooltip.Provider>
        <WhatsNewDialog catalog={channelCatalog} />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Technical release notes ↗" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("shell:open-external", {
        url: "https://github.com/HamedMP/matrix-os/releases?q=desktop-v0.1.24-canary&expanded=true",
      });
    });
  });

  it("opens on demand from the account menu without an update", () => {
    renderDialog();
    expect(screen.queryByRole("dialog", { name: "What's New" })).toBeNull();

    React.act(() => openWhatsNew());

    expect(useDesktopUpdate.getState().whatsNewOpen).toBe(true);
    expect(screen.getByRole("heading", { name: "Your agents, at a glance" })).toBeTruthy();
    expect(screen.getByText("Released November 16, 2026")).toBeTruthy();
  });

  it("does not let a late update load close a What's New the user opened", async () => {
    let resolveWhatsNew!: (value: { release: null; shouldOpen: boolean }) => void;
    const whatsNew = new Promise<{ release: null; shouldOpen: boolean }>((resolve) => {
      resolveWhatsNew = resolve;
    });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "update:get-state") return { status: "disabled" };
      if (channel === "update:get-whats-new") return whatsNew;
      return { ok: true };
    });
    vi.stubGlobal("operator", { invoke, on: vi.fn(() => vi.fn()) });

    const dispose = useDesktopUpdate.getState().initialize();
    openWhatsNew();
    resolveWhatsNew({ release: null, shouldOpen: false });
    await whatsNew;
    await Promise.resolve();
    await Promise.resolve();

    expect(useDesktopUpdate.getState().whatsNewOpen).toBe(true);
    dispose();
  });

  it("hides canary notes on a stable build", async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "update:get-state") return { status: "disabled" };
      if (channel === "update:get-whats-new") return { release: null, shouldOpen: false };
      if (channel === "app:get-version") return { version: "0.1.23", source: null, channel: "stable" };
      return { ok: true };
    });
    vi.stubGlobal("operator", { invoke, on: vi.fn(() => vi.fn()) });

    const dispose = useDesktopUpdate.getState().initialize();
    await waitFor(() => expect(useDesktopUpdate.getState().buildChannel).toBe("stable"));
    React.act(() => openWhatsNew());
    renderDialog();

    const rail = screen.getByRole("navigation", { name: "Releases" });
    expect(within(rail).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "0.1.23StableNov 9 · WhatsApp + Matrix AI",
    ]);
    dispose();
  });

  it("only honors the preview flag in development builds", () => {
    expect(whatsNewPreviewRequested({ DEV: true, VITE_MATRIX_DESKTOP_PREVIEW_WHATS_NEW: "1" })).toBe(true);
    expect(whatsNewPreviewRequested({ DEV: false, VITE_MATRIX_DESKTOP_PREVIEW_WHATS_NEW: "1" })).toBe(false);
    expect(whatsNewPreviewRequested({ DEV: true })).toBe(false);
  });

  it("marks an unacknowledged release as unseen until What's New is closed", async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "update:get-state") return { status: "disabled" };
      if (channel === "update:get-whats-new") {
        return { release: { version: "0.1.24", notes: "" }, shouldOpen: true };
      }
      return { ok: true };
    });
    vi.stubGlobal("operator", { invoke, on: vi.fn(() => vi.fn()) });

    const dispose = useDesktopUpdate.getState().initialize();
    await waitFor(() => expect(useDesktopUpdate.getState().whatsNewUnseen).toBe(true));
    useDesktopUpdate.getState().closeWhatsNew();
    expect(useDesktopUpdate.getState().whatsNewUnseen).toBe(false);
    dispose();
  });
});
