// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../home/apps/utilities/src/App";
vi.mock("../../home/apps/utilities/src/WorkspaceRouter", () => ({ WorkspaceRouter: () => <textarea aria-label="Draft"/> }));
let notify!: (request: { requestId: string; type: "request" | "cancel" }) => void;
const respondToClose = vi.fn().mockResolvedValue({ ok: true });
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { utilitiesClose: {
    onCloseRequest: (fn: typeof notify) => { notify = fn; return vi.fn(); }, respondToClose,
  } } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "MatrixOS"); vi.clearAllMocks(); });
it("reads the current dirty workspace at request time and preserves its draft after Keep working", () => {
  render(<App/>); fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "my draft" } });
  act(() => notify({ requestId: "request-1", type: "request" }));
  expect(screen.getByRole("dialog", { name: "Close Utilities?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep working" }));
  expect(respondToClose).toHaveBeenLastCalledWith("request-1", false);
  expect((screen.getByLabelText("Draft") as HTMLTextAreaElement).value).toBe("my draft");
  act(() => notify({ requestId: "request-2", type: "request" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Utilities", exact: true }));
  expect(respondToClose).toHaveBeenLastCalledWith("request-2", true);
});
it("approves a clean catalog and cancels a timed-out request without discarding workspace input", () => {
  render(<App/>); act(() => notify({ requestId: "clean", type: "request" }));
  expect(respondToClose).toHaveBeenCalledWith("clean", true);
  fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "retain" } });
  act(() => notify({ requestId: "timeout", type: "request" }));
  act(() => notify({ requestId: "timeout", type: "cancel" }));
  expect(screen.queryByRole("dialog", { name: "Close Utilities?" })).toBeNull();
  expect((screen.getByLabelText("Draft") as HTMLTextAreaElement).value).toBe("retain");
});
it("checks edits made after close was requested but before its IPC delivery", () => {
  render(<App/>); fireEvent.click(screen.getByText("Word Counter", { selector: "strong" }).closest("button")!);
  const deliverLater = () => notify({ requestId: "delayed", type: "request" });
  // The native process requests closure while this initially clean workspace is still editable.
  expect(respondToClose).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "newer input" } });
  act(deliverLater);
  expect(screen.getByRole("dialog", { name: "Close Utilities?" })).toBeTruthy();
  expect(respondToClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep working" }));
  expect(respondToClose).toHaveBeenCalledWith("delayed", false);
  expect((screen.getByLabelText("Draft") as HTMLTextAreaElement).value).toBe("newer input");
});
