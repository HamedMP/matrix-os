// @vitest-environment jsdom

import * as Popover from "@radix-ui/react-popover";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { createRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHelpMenu } from "../../packages/ui/src/desktop-top-bar.js";

// Production can bundle the shell and shared UI with separate Radix contexts.
// A scoped owner reproduces that isolation without depending on package layout.
const useChecklistScope = Popover.createPopoverScope();

function ScopedChecklist() {
  const scope = useChecklistScope(undefined);
  return (
    <Popover.Root {...scope}>
      <DesktopHelpMenu
        triggerRef={createRef<HTMLButtonElement>()}
        anchorTrigger={(trigger: ReactNode) => <Popover.Anchor {...scope} asChild>{trigger}</Popover.Anchor>}
        gettingStarted={<Popover.Trigger {...scope}>Getting started</Popover.Trigger>}
        incomplete
        onSupport={vi.fn()}
        discordIcon={null}
      />
      <Popover.Portal {...scope}>
        <Popover.Content {...scope} aria-label="Checklist">Finish setup</Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

afterEach(async () => {
  cleanup();
  // Radix restores focus on a deferred timer after unmount.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
});

describe("Help menu popover context ownership", () => {
  it("mounts and opens the checklist when its owner has an isolated context", () => {
    render(<ScopedChecklist />);

    fireEvent.click(screen.getByRole("button", { name: "Help", exact: true }));
    expect(screen.getByRole("dialog", { name: "Help", exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Getting started", exact: true }));
    expect(screen.getByRole("dialog", { name: "Checklist", exact: true })).toBeTruthy();
  });

  it("supports a trigger ref without requiring an external unscoped root", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(<DesktopHelpMenu triggerRef={triggerRef} gettingStarted={null} incomplete={false}
      onSupport={vi.fn()} discordIcon={null} />);

    const help = screen.getByRole("button", { name: "Help", exact: true });
    expect(triggerRef.current).toBe(help);
    fireEvent.click(help);
    expect(screen.getByRole("dialog", { name: "Help", exact: true })).toBeTruthy();
  });
});
