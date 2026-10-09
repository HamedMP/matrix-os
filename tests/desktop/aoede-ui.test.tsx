// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AoedeServerMessage } from "@matrix-os/contracts";
import type { UiResult } from "../../packages/ui/src/aoede/useAoedeSession";

type UiFrame = Extract<AoedeServerMessage, { type: "aoede:ui" }>;
const h = vi.hoisted(() => ({ onUi: null as null | ((frame: UiFrame) => UiResult) }));
// Capture the shared session's public host contract without starting media,
// readiness requests, or a paid voice session. Navigation stores remain real.
vi.mock("@matrix-os/ui/aoede", () => ({
  useAoedeSession: (_active: boolean, onUi: (frame: UiFrame) => UiResult) => {
    h.onUi = onUi;
    return { refreshReadiness: async () => undefined };
  },
  AoedeOverlayView: () => null,
}));
vi.mock("../../desktop/src/renderer/src/lib/kernel-wiring", () => ({ getKernelSocket: () => null }));
vi.mock("../../desktop/src/renderer/src/stores/connection", async () => {
  const { create } = await import("zustand");
  return { useConnection: create(() => ({
    status: "signed-in" as const, handle: "owner", userId: "owner-a",
    platformHost: "https://platform.example", runtimeSlot: "primary", authGeneration: 7,
    providerCatalogGeneration: 0,
  })) };
});
vi.mock("../../desktop/src/renderer/src/features/aoede/transport", async () => {
  const { useConnection } = await import("../../desktop/src/renderer/src/stores/connection");
  const { desktopProviderIdentityKey } = await import("../../desktop/src/renderer/src/lib/provider-settings-identity");
  return { createDesktopAoedeTransport: () => ({ identityKey: desktopProviderIdentityKey(useConnection.getState()) }) };
});
vi.mock("../../desktop/src/renderer/src/features/apps/apps.api", () => ({
  useAppsQuery: () => ({ data: [
    { slug: "notes", name: "Notes", path: "apps/notes/index.html" },
    { slug: "notes-team", name: "Team Notes", path: "apps/notes-team/index.html" },
    { slug: "notes-personal", name: "Personal Notes", path: "apps/notes-personal/index.html" },
  ] }),
}));

import DesktopAoede from "../../desktop/src/renderer/src/features/aoede/DesktopAoede";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useDesktopAoede } from "../../desktop/src/renderer/src/features/aoede/microphone";

function frame(action: UiFrame["action"], target = "notes", phase: UiFrame["phase"] = "execute"): UiFrame {
  return { type: "aoede:ui", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", action, target, phase };
}
function execute(message: UiFrame): UiResult {
  let result!: UiResult;
  act(() => { result = h.onUi!(message); });
  return result;
}
function snapshot() {
  return { tabs: useTabs.getState(), surfaces: useDesktopSurfaces.getState(), ui: useUi.getState() };
}
beforeEach(() => {
  useTabs.setState(useTabs.getInitialState());
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState());
  useUi.setState(useUi.getInitialState());
  useConnection.setState({ authGeneration: 7 });
  useDesktopAoede.getState().setOpen(true);
  render(<DesktopAoede />);
});
afterEach(() => { cleanup(); useDesktopAoede.getState().setOpen(false); h.onUi = null; });

it("resolves built-in Notes without mutation, opens a native Notes tab, and closes it", () => {
  const before = snapshot();
  expect(execute(frame("open_app", "  nOtEs  ", "resolve"))).toEqual({ status: "ok", slug: "notes" });
  expect(snapshot()).toEqual(before);
  expect(execute(frame("open_app"))).toEqual({ status: "ok", slug: "notes" });
  const notes = useTabs.getState().tabs.find(tab => tab.kind === "notes")!;
  expect(notes).toMatchObject({ kind: "notes", title: "Notes", closable: true });
  expect(useTabs.getState().tabs.some(tab => tab.kind === "app")).toBe(false);
  expect(useTabs.getState().activeTabId).toBe(notes.id);
  expect(useDesktopSurfaces.getState().surfaces[notes.id]?.mode).toBe("window");
  expect(execute(frame("close_app"))).toEqual({ status: "ok", slug: "notes" });
  expect(useTabs.getState().tabs.some(tab => tab.id === notes.id)).toBe(false);
  expect(execute(frame("close_app"))).toEqual({ status: "not_found" });
});

it("reactivates minimized and closed Notes, closing a retained nonclosable tab's surface", () => {
  let id!: string;
  act(() => {
    id = useTabs.getState().openTab({ kind: "notes", title: "Notes", closable: false });
    useDesktopSurfaces.getState().reconcileTabs(useTabs.getState().tabs.map(tab => tab.id), { width: 1200, height: 800 });
    useDesktopSurfaces.getState().minimizeSurface(id);
  });
  expect(useDesktopSurfaces.getState().surfaces[id]?.mode).toBe("minimized");
  expect(execute(frame("open_app"))).toEqual({ status: "ok", slug: "notes" });
  expect(useDesktopSurfaces.getState().surfaces[id]?.mode).toBe("window");
  expect(execute(frame("close_app"))).toEqual({ status: "ok", slug: "notes" });
  expect(useTabs.getState().tabs.filter(tab => tab.kind === "notes")).toEqual([
    expect.objectContaining({ id, closable: false }),
  ]);
  expect(useDesktopSurfaces.getState().surfaces[id]?.mode).toBe("closed");
  expect(execute(frame("open_app"))).toEqual({ status: "ok", slug: "notes" });
  expect(useTabs.getState().activeTabId).toBe(id);
  expect(useTabs.getState().tabs.filter(tab => tab.kind === "notes")).toHaveLength(1);
  expect(useDesktopSurfaces.getState().surfaces[id]?.mode).toBe("window");
});

it("does not silently choose an ambiguous app name", () => {
  const before = snapshot();
  expect(execute(frame("open_app", "Note", "resolve"))).toEqual({ status: "ambiguous" });
  expect(snapshot()).toEqual(before);
});

it("rejects a retained old-identity callback without any UI mutation", () => {
  const stale = h.onUi!;
  act(() => { useConnection.setState({ authGeneration: 8 }); });
  const before = snapshot();
  for (const action of ["open_app", "close_app"] as const) {
    for (const phase of ["resolve", "execute"] as const) {
      expect(stale(frame(action, "notes", phase))).toEqual({ status: "failed" });
      expect(snapshot()).toEqual(before);
    }
  }
});
