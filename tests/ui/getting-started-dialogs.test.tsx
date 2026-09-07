// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GettingStartedVisibilityProvider, useGettingStartedVisibility } from "../../packages/ui/src/getting-started-visibility";
import { Dialog as WebDialog, DialogContent, DialogTitle } from "../../shell/src/components/ui/dialog";
import { Dialog as ElectronDialog } from "../../desktop/src/renderer/src/design/primitives";
function Card() {
  const { visible, setRequestedOpen } = useGettingStartedVisibility();
  return <><button onClick={() => setRequestedOpen(true)}>Open checklist</button>{visible && <p>Checklist visible</p>}</>;
}
afterEach(cleanup);
it("does not classify a nonmodal dialog as a blocker", () => {
  render(<GettingStartedVisibilityProvider scope="test"><Card /><WebDialog open modal={false}><DialogContent aria-describedby={undefined}><DialogTitle>Nonmodal</DialogTitle></DialogContent></WebDialog></GettingStartedVisibilityProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Open checklist" }));
  expect(screen.queryByText("Checklist visible")).not.toBeNull();
});
for (const electron of [false, true]) describe(electron ? "Electron modal registration" : "web modal registration", () => {
  function Scene({ first = false, second = false }) {
    const dialog = (open: boolean, title: string) => electron
      ? <ElectronDialog open={open} onClose={() => {}} title={title}><button>Continue</button></ElectronDialog>
      : <WebDialog open={open}><DialogContent aria-describedby={undefined}><DialogTitle>{title}</DialogTitle><button>Continue</button></DialogContent></WebDialog>;
    return <GettingStartedVisibilityProvider scope="test"><Card />{dialog(first, "First")}{dialog(second, "Second")}</GettingStartedVisibilityProvider>;
  }
  it("registers actual modal presence and handles overlapping dialogs", () => {
    const view = render(<Scene />);
    fireEvent.click(screen.getByRole("button", { name: "Open checklist" }));
    view.rerender(<Scene first second />);
    expect(screen.queryByText("Checklist visible")).toBeNull();
    view.rerender(<Scene second />);
    expect(screen.queryByText("Checklist visible")).toBeNull();
    view.rerender(<Scene />);
    expect(screen.queryByText("Checklist visible")).not.toBeNull();
  });
});
