// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalControls } from "../../packages/ui/src/terminal/TerminalControls";
import type { TerminalControlsState } from "../../packages/ui/src/terminal/use-terminal-controls";

afterEach(cleanup);
const controls = { enabled: true, paneActionsEnabled: true, sessionName: "alpha", busy: false,
  preferences: { keyboard: { profile: "mac", overrides: {} } }, runAction: vi.fn(), error: null,
} as unknown as TerminalControlsState;

describe("Terminal attachment action", () => {
  it("shows an accessible attachment icon alongside pane controls and accepts arbitrary files", () => {
    const onSelectFiles = vi.fn();
    const { container } = render(<TerminalControls controls={controls} attachment={{ enabled: true, onSelectFiles }} />);
    const button = screen.getByRole("button", { name: "Attach files" });
    expect(button.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Terminal pane controls");
    fireEvent.click(button);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe("");
    const files = [new File(["pdf"], "brief.pdf"), new File(["notes"], "notes.txt")];
    fireEvent.change(input, { target: { files } });
    expect(onSelectFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(input.value).toBe("");
  });

  it("disables selection while unavailable and discards a picker result after changing sessions", () => {
    const onSelectFiles = vi.fn();
    const { container, rerender } = render(<TerminalControls controls={controls} attachment={{ enabled: true, onSelectFiles }} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    rerender(<TerminalControls controls={{ ...controls, sessionName: "beta" }} attachment={{ enabled: true, onSelectFiles }} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["x"], "stale.txt")] } });
    expect(onSelectFiles).not.toHaveBeenCalled();
    rerender(<TerminalControls controls={controls} attachment={{ enabled: false, onSelectFiles }} />);
    expect(screen.getByRole("button", { name: "Attach files" }).hasAttribute("disabled")).toBe(true);
  });
});
