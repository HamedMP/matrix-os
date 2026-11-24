// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmSend, Dialog } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

function DialogHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => { onClose?.(); setOpen(false); };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <Dialog open={open} onClose={close} title="Account settings" description="Choose how this account syncs" footer={<button type="button" onClick={close}>Done</button>}>
        <label>Name <input /></label>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("still closes on Escape and keeps Tab inside after the focused control is removed", () => {
    const onClose = vi.fn();
    function Shrinking() {
      const [step, setStep] = useState(0);
      return (
        <Dialog open onClose={onClose} title="Pick a folder">
          {step === 0 ? <button key="folder" type="button" onClick={() => setStep(1)}>Folder Documents</button> : <button key="file" type="button">Document contract.docx</button>}
        </Dialog>
      );
    }
    render(<Shrinking />);
    const folder = screen.getByRole("button", { name: "Folder Documents" });
    folder.focus();
    fireEvent.click(folder);
    // The focused button is gone, so focus has fallen back to the page.
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(screen.getByRole("dialog", { name: "Pick a folder" }).contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus inside, traps Tab, closes on Escape and returns focus to the opener", () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Account settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button, input"));
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(focusables[0], { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on backdrop click but not on clicks inside the panel", () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = screen.getByTestId("oui-dialog-backdrop");
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmSend", () => {
  it("focuses Cancel first, lists recipients and only sends on explicit confirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(<ConfirmSend open onCancel={onCancel} onConfirm={onConfirm} recipients={["ada@example.com", "lin@example.com"]} summary="Quarterly report" />);
    const dialog = screen.getByRole("alertdialog", { name: "Send this email?" });
    expect(dialog.textContent).toContain("ada@example.com");
    expect(dialog.textContent).toContain("lin@example.com");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows a generic error when sending fails and keeps the dialog open", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onConfirm = vi.fn().mockRejectedValue(new Error("Gmail 500: upstream token expired at /home/x"));
    render(<ConfirmSend open onCancel={vi.fn()} onConfirm={onConfirm} recipients={["ada@example.com"]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Could not send. Try again.");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<ConfirmSend open kind="invite" onCancel={onCancel} onConfirm={vi.fn()} recipients={["team@example.com"]} />);
    expect(screen.getByRole("alertdialog", { name: "Send this invitation?" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
