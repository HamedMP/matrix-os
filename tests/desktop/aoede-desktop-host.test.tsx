// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AoedeProviderProps } from "../../packages/ui/src/aoede/controller";
const state = vi.hoisted(() => ({
  props: null as AoedeProviderProps | null,
  connection: { status: "signed-in", userId: "owner_a", platformHost: "https://platform.test", runtimeSlot: "pr-100", authGeneration: 1, api: { forRuntime: vi.fn() } },
  tabs: { tabs: [] as { id: string; kind: string; slug: string }[], openTab: vi.fn(), closeTab: vi.fn() },
  get: vi.fn(), openFile: vi.fn(),
}));
vi.mock("@matrix-os/ui/aoede", () => ({ AoedeProvider: (props: AoedeProviderProps) => { state.props = props; return props.children; }, AoedeAssistant: () => null }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: Object.assign((selector: (s: typeof state.connection) => unknown) => selector(state.connection), { getState: () => state.connection }) }));
vi.mock("../../desktop/src/renderer/src/stores/tabs", () => ({ useTabs: { getState: () => state.tabs } }));
vi.mock("../../desktop/src/renderer/src/features/editor/desktop-editor-store", () => ({ openFileInDesktopEditor: state.openFile }));
vi.mock("../../desktop/src/renderer/src/features/apps/apps.api", () => ({ parseApps: (apps: unknown) => apps }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import DesktopAoedeHost from "../../desktop/src/renderer/src/features/aoede/DesktopAoedeHost";
beforeEach(() => {
  vi.clearAllMocks(); state.connection.authGeneration = 1;
  state.connection.api.forRuntime.mockReturnValue({ get: state.get });
  state.get.mockResolvedValue([{ slug: "notes", name: "Notes", appIdentity: "notes" }]);
  state.tabs.tabs = [{ id: "notes_tab", kind: "app", slug: "notes" }, { id: "other_tab", kind: "app", slug: "other" }];
  render(<DesktopAoedeHost><div /></DesktopAoedeHost>);
});
afterEach(cleanup);
it("closes matching app tabs without opening or fetching apps", async () => {
  await state.props!.onOpenNavigation!({ kind: "close_app", app: "notes", path: "/apps/notes" });
  expect(state.tabs.closeTab).toHaveBeenCalledWith("notes_tab");
  expect(state.tabs.closeTab).toHaveBeenCalledTimes(1);
  expect(state.tabs.openTab).not.toHaveBeenCalled();
  expect(state.get).not.toHaveBeenCalled();
});
it("opens owned result files using existing desktop file navigation", () => {
  state.props!.onOpenResult?.("data/report.md");
  expect(state.openFile).toHaveBeenCalledWith("data/report.md");
});
it("rejects file and close callbacks after the captured identity changes", () => {
  state.connection.authGeneration = 2;
  state.props!.onOpenResult?.("data/report.md");
  state.props!.onOpenNavigation!({ kind: "close_app", app: "notes", path: "/apps/notes" });
  expect(state.openFile).not.toHaveBeenCalled(); expect(state.tabs.closeTab).not.toHaveBeenCalled();
});
it("does not open an app when its lookup settles after an identity change", async () => {
  let resolve!: (apps: unknown) => void;
  state.get.mockReturnValue(new Promise(done => { resolve = done; }));
  state.props!.onOpenNavigation!({ app: "notes", path: "/apps/notes" });
  state.connection.authGeneration = 2;
  resolve([{ slug: "notes", name: "Notes" }]);
  await Promise.resolve(); await Promise.resolve();
  expect(state.tabs.openTab).not.toHaveBeenCalled();
});

it("opens an installed app with its canonical identity", async () => {
  state.props!.onOpenNavigation!({ app: "notes", path: "/apps/notes" });
  await vi.waitFor(() => expect(state.tabs.openTab).toHaveBeenCalledWith({ kind: "app", slug: "notes", title: "Notes", appIdentity: "notes" }));
});
it("leaves other apps untouched when the requested app is already closed", () => {
  state.props!.onOpenNavigation!({ kind: "close_app", app: "missing", path: "/apps/missing" });
  expect(state.tabs.closeTab).not.toHaveBeenCalled(); expect(state.tabs.openTab).not.toHaveBeenCalled();
});
