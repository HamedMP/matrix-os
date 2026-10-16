// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { WebBotCreationComposer } from "../../shell/src/components/chat/WebBotCreationComposer";
afterEach(cleanup);
function Harness({ submit, available = true }: { submit: (text: string) => Promise<boolean>; available?: boolean }) {
  const [value, onChange] = useState("Describe my agent");
  return <WebBotCreationComposer scopeKey="creation_a" value={value} onChange={onChange} onSubmit={submit}
    pending={false} available={available} isCurrent={() => true}/>;
}
it("uses the production Web input and clears only accepted messages", async () => {
  const submit = vi.fn(async () => false);
  render(<Harness submit={submit}/>);
  const input = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(input, { target: { value: "Prepare a weekly report" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith("Prepare a weekly report"));
  expect(input).toHaveValue("Prepare a weekly report");
  submit.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(input).toHaveValue(""));
});
it("preserves newer input across late completion and disables unsupported attachments", async () => {
  let finish!: (accepted: boolean) => void;
  render(<Harness submit={() => new Promise(resolve => { finish = resolve; })}/>);
  const input = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.change(input, { target: { value: "Additional details" } });
  await act(async () => finish(true));
  expect(input).toHaveValue("Additional details");
  expect(screen.getByRole("button", { name: "Attachments are unavailable while setting up an agent." })).toBeDisabled();
});
it("cannot send when the real creation transport is unavailable", () => {
  render(<Harness submit={vi.fn()} available={false}/>);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});
it("does not clear a replaced creation scope including A to B to A", async () => {
  let finish!: (accepted: boolean) => void;
  const onChange = vi.fn(), props = { value: "Original", onChange, pending: false, available: true,
    isCurrent: () => true, onSubmit: () => new Promise<boolean>(resolve => { finish = resolve; }) };
  const view = render(<WebBotCreationComposer {...props} scopeKey="a"/>);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  view.rerender(<WebBotCreationComposer {...props} scopeKey="b"/>);
  view.rerender(<WebBotCreationComposer {...props} scopeKey="a"/>);
  await act(async () => finish(true));
  expect(onChange).not.toHaveBeenCalled();
});
