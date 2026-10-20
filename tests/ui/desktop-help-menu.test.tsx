// @vitest-environment jsdom
import React, { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHelpMenu } from "../../packages/ui/src/desktop-top-bar";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("desktop Help popover ownership", () => {
  it("renders and opens with a checklist trigger ref without an external popover provider", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onSupport = vi.fn();
    render(<DesktopHelpMenu triggerRef={triggerRef} incomplete gettingStarted={<button type="button">Getting started</button>}
      onSupport={onSupport} discordIcon={<span />} />);
    expect(triggerRef.current).toBe(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(triggerRef.current!);
    expect(screen.getByRole("dialog", { name: "Help" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Support chat" }));
    expect(onSupport).toHaveBeenCalledOnce();
  });
});
