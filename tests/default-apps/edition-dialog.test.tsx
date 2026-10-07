// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Dialog from "../../home/app-templates/connected-starter/src/edition/Dialog";
it("opens a native modal and routes Escape cancellation through the owner", () => {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: showModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.open = false;
    },
  });
  const cancel = vi.fn();
  render(
    <Dialog titleId="title" onClose={cancel}>
      <h2 id="title">Confirm account change</h2>
      <button>Keep account</button>
    </Dialog>,
  );
  expect(showModal).toHaveBeenCalledOnce();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true }),
  );
  expect(cancel).toHaveBeenCalledOnce();
});
