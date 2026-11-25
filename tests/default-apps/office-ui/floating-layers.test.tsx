// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, Popover, Ribbon, type RibbonTab } from "../../../home/apps/_shared/office-ui";
import { FloatingMenu } from "../../../home/apps/_shared/office-ui/FloatingMenu";

afterEach(cleanup);

// Each floating layer is a stacking context, so a surface rendered inside the
// layer that holds its anchor paints above that layer whatever the z-index
// values. A surface left in the document body would sit behind a higher layer,
// such as a popover (z 90) behind a dialog's backdrop (z 100).

function PickerButton({ label, children }: { label: string; children: React.ReactNode }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>{label}</button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label={`${label} options`}>
        {children}
      </Popover>
    </>
  );
}

function MenuButton() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>Shape</button>
      {open && <FloatingMenu anchorRef={anchorRef} label="Shapes" items={[{ id: "box", label: "Box" }]} onSelect={vi.fn()} onClose={() => setOpen(false)} />}
    </>
  );
}

describe("floating layers", () => {
  it("renders a popover opened inside a dialog in the dialog's layer, above its backdrop, and keeps its choices usable", () => {
    const onClose = vi.fn();
    const onPick = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Format">
        <PickerButton label="Colour"><button type="button" onClick={onPick}>Red</button></PickerButton>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Colour" }));
    const popover = screen.getByRole("dialog", { name: "Colour options" });
    const backdrop = screen.getByTestId("oui-dialog-backdrop");
    expect(popover.parentElement).toBe(backdrop);
    // Outside the dialog panel, so the dialog's Tab cycle never runs into it.
    expect(screen.getByRole("dialog", { name: "Format" }).contains(popover)).toBe(false);

    const red = screen.getByRole("button", { name: "Red" });
    fireEvent.mouseDown(red);
    fireEvent.click(red);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders a floating menu opened inside a dialog in the dialog's layer", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Insert">
        <MenuButton />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Shape" }));
    expect(screen.getByRole("menu", { name: "Shapes" }).parentElement).toBe(screen.getByTestId("oui-dialog-backdrop"));
  });

  it("renders a popover opened from backstage content inside the backstage", () => {
    const tabs: RibbonTab[] = [
      {
        id: "file",
        label: "File",
        mode: "backstage",
        backstage: { items: [{ id: "share", label: "Share", render: () => <PickerButton label="People"><button type="button">Ada</button></PickerButton> }] },
      },
      { id: "home", label: "Home", groups: [] },
    ];
    render(<Ribbon tabs={tabs} activeTab="home" onTabChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    const popover = screen.getByRole("dialog", { name: "People options" });
    expect(popover.parentElement).toBe(screen.getByRole("dialog", { name: "File" }));
  });

  it("renders a popover inside the popover that holds its anchor, and a top-level one in the document body", () => {
    render(
      <PickerButton label="Outer">
        <PickerButton label="Inner"><button type="button">Choice</button></PickerButton>
      </PickerButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Outer" }));
    const outer = screen.getByRole("dialog", { name: "Outer options" });
    expect(outer.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Inner" }));
    expect(screen.getByRole("dialog", { name: "Inner options" }).parentElement).toBe(outer);
  });
});
