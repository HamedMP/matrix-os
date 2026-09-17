// @vitest-environment jsdom
import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TerminalsTab from "../../desktop/src/renderer/src/features/terminal/TerminalsTab";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useTerminalAppearance } from "../../desktop/src/renderer/src/stores/terminal-appearance";

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: () => <div>Terminal viewport</div>,
}));

beforeEach(() => {
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", api: {
    get: vi.fn(async (path: string) => path === "/api/agents"
      ? { agents: ["claude", "codex", "opencode", "pi"].map(id => ({ id, installState: "installed" })) }
      : { preferences: { shellThemeId: "dark" } }),
  } as never });
  useShellSessions.setState({ ...useShellSessions.getInitialState(),
    sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    load: vi.fn().mockResolvedValue([]),
  }, true);
  useTabs.setState(useTabs.getInitialState(), true);
  useTerminalAppearance.setState({ ...useTerminalAppearance.getInitialState(), themeId: "dark", hydrated: true }, true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps deletion locked across Cancel, Escape and backdrop until failure settles", async () => {
  let finish!: (ok: boolean) => void;
  const deleteSession = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  useShellSessions.setState({ deleteSession });
  render(<Tooltip.Provider><TerminalsTab /></Tooltip.Provider>);
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-main" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(deleteSession).toHaveBeenCalledOnce();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect((cancel as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(cancel);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  const overlay = document.querySelector(".fixed.inset-0[data-state=\"open\"]");
  expect(overlay).toBeTruthy();
  fireEvent.pointerDown(overlay!, { button: 0, ctrlKey: false });
  expect(screen.getByText("Delete matrix-main?")).toBeTruthy();
  expect((screen.getByLabelText("Open matrix-main") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(false));
  expect(screen.queryByText("Delete matrix-main?")).toBeNull();
  expect((screen.getByLabelText("Open matrix-main") as HTMLButtonElement).disabled).toBe(false);
});
