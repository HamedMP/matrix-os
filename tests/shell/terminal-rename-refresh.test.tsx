// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ShellSessionGroup } from "../../shell/src/components/terminal/TerminalSidebarItems";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state";
afterEach(cleanup);

it("keeps the original Web rename callback across a background refresh", async () => {
  const original = { name: "stable-ref", workspaceId: "workspace", tabId: "tab", revision: 3, workspaceRevision: 7, subtitle: "A" } as ShellSessionSummary;
  const rename = vi.fn().mockResolvedValue(false);
  const noop = () => undefined;
  const props = { label: "Active" as const, foreground: true, selectedShellName: null, deletingShellNames: [], draggingShellName: null, dragOverShellName: null,
    onOpen: noop, onToggle: noop, onPin: noop, onDelete: noop, onDragStart: noop, onDragOver: noop, onDrop: noop, onDragEnd: noop };
  const view = render(<ShellSessionGroup {...props} shells={[original]} onRename={rename} />);
  fireEvent.doubleClick(screen.getByTestId("terminal-session-name-stable-ref"));
  view.rerender(<ShellSessionGroup {...props} shells={[{ ...original, subtitle: "B", revision: 4 }]} onRename={rename} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "C" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(rename).toHaveBeenCalledWith(original, "C"));
});
