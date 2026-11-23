// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import type { ShortcutSnapshot } from "@desktop/shared/shortcuts-ipc";
import ShortcutsSection from "@desktop/renderer/src/features/settings/sections/ShortcutsSection";
import { useShortcuts } from "@desktop/renderer/src/stores/shortcuts";

function macSnapshot(): ShortcutSnapshot {
  const overrides = { version: 1 as const, overrides: {} };
  return { platform: "mac", overrides, effective: resolveShortcuts(overrides, "mac") };
}

let invoke: ReturnType<typeof vi.fn>;

function recordingCalls(): unknown[] {
  return invoke.mock.calls.filter(([channel]) => channel === "shortcuts:set-recording").map(([, payload]) => payload);
}

async function nextAppRow(): Promise<HTMLElement> {
  return screen.findByRole("group", { name: "Next app" });
}

beforeEach(() => {
  useShortcuts.setState({ snapshot: null, error: null });
  invoke = vi.fn(async (channel: string) => {
    if (channel === "shortcuts:get") return macSnapshot();
    if (channel === "shortcuts:set-recording") return { ok: true };
    throw new Error(`unexpected channel ${channel}`);
  });
  vi.stubGlobal("operator", { invoke, on: vi.fn(() => () => undefined) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ShortcutsSection", () => {
  it("shows a loading state, loads the bindings, then lists them under the Shortcuts header", async () => {
    let resolveGet: (value: ShortcutSnapshot) => void = () => undefined;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));

    render(<ShortcutsSection />);

    expect(screen.getByRole("heading", { name: "Shortcuts" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading shortcuts…");
    expect(invoke).toHaveBeenCalledWith("shortcuts:get", {});

    resolveGet(macSnapshot());

    const row = await nextAppRow();
    expect(within(row).getByRole("group", { name: "Control Tab" }).textContent).toBe("⌃⇥");
    expect(screen.queryByText("Loading shortcuts…")).toBeNull();
  });

  it("tells the main process when recording starts and stops", async () => {
    render(<ShortcutsSection />);
    const row = await nextAppRow();

    fireEvent.click(within(row).getByRole("button", { name: "Add shortcut" }));
    await waitFor(() => expect(recordingCalls()).toEqual([{ recording: true }]));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(recordingCalls()).toEqual([{ recording: true }, { recording: false }]));
  });

  it("releases recording when the section unmounts mid-recording", async () => {
    const { unmount } = render(<ShortcutsSection />);
    const row = await nextAppRow();
    fireEvent.click(within(row).getByRole("button", { name: "Add shortcut" }));
    await waitFor(() => expect(recordingCalls()).toEqual([{ recording: true }]));

    unmount();

    expect(recordingCalls()).toEqual([{ recording: true }, { recording: false }]);
  });

  it("logs a failed recording notice and keeps recording in the UI", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("ipc down");
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "shortcuts:get") return macSnapshot();
      throw failure;
    });
    render(<ShortcutsSection />);
    const row = await nextAppRow();

    fireEvent.click(within(row).getByRole("button", { name: "Add shortcut" }));

    await waitFor(() => expect(warn).toHaveBeenCalledWith("[shortcuts] could not report recording state:", failure));
    expect(within(row).getByRole("status", { name: "Recording shortcut for Next app" })).toBeTruthy();
  });

  it("shows the save error when the main process rejects the change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "shortcuts:get") return macSnapshot();
      if (channel === "shortcuts:set") throw new Error("disk full");
      return { ok: true };
    });
    render(<ShortcutsSection />);
    const row = await nextAppRow();

    fireEvent.click(within(row).getByRole("button", { name: /Remove/ }));

    expect((await within(row).findByRole("alert")).textContent).toBe("Could not save shortcut. Please try again.");
    expect(within(row).getByRole("group", { name: "Control Tab" })).toBeTruthy();
  });
});
