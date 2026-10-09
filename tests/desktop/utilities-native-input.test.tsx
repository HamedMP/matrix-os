// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import App from "../../home/apps/utilities/src/App";
afterEach(cleanup);
it("retains controlled input while its dirty handler marks the actual workspace dirty", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  render(<App />);
  fireEvent.click(screen.getByText("Word Counter", { exact: true }));
  const input = await screen.findByLabelText("Your text");
  fireEvent.input(input, { target: { value: "Keep this Electron draft." } });
  expect((input as HTMLTextAreaElement).value).toBe("Keep this Electron draft.");
  fireEvent.click(screen.getByText("← All utilities"));
  expect(await screen.findByText("Leave this workspace?")).toBeTruthy();
  fireEvent.click(screen.getByText("Keep working"));
  expect((input as HTMLTextAreaElement).value).toBe("Keep this Electron draft.");
});
