// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ElectronBotCreationComposer } from "../../desktop/src/renderer/src/features/chat/ElectronBotCreationComposer";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

afterEach(cleanup);
function Harness({ submit, available = true }: { submit: (text: string) => Promise<boolean>; available?: boolean }) {
  const [value, onChange] = useState("Describe my agent");
  return <ElectronBotCreationComposer scopeKey="creation_a" value={value} onChange={onChange} onSubmit={submit}
    pending={false} available={available} catalog={createCanonicalProviderCatalogFixture()} isCurrent={() => true}/>;
}
it("uses the production controlled composer without exposing model/permission controls", async () => {
  const submit = vi.fn(async () => true);
  render(<Harness submit={submit}/>);
  const input = screen.getByRole("textbox", { name: "Message chat" });
  await setSharedComposerText(input, "Prepare a weekly report");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith("Prepare a weekly report"));
  await waitFor(() => expect(input.textContent).toBe(""));
  expect(screen.queryByRole("button", { name: "Chat settings" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Permission mode" })).toBeNull();
});
it("retains rejected text and does not send while the real bridge is unavailable", async () => {
  const submit = vi.fn(async () => false);
  const view = render(<Harness submit={submit}/>);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("textbox", { name: "Message chat" }).textContent).toBe("Describe my agent");
  view.rerender(<Harness submit={submit} available={false}/>);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});
it("does not clear newer input when a prior real submission finishes", async () => {
  let finish!: (accepted: boolean) => void;
  render(<Harness submit={() => new Promise(resolve => { finish = resolve; })}/>);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const input = screen.getByRole("textbox", { name: "Message chat" });
  await setSharedComposerText(input, "Additional details");
  await act(async () => finish(true));
  expect(input.textContent).toBe("Additional details");
});
it("rejects completion from a replaced creation scope including A to B to A", async () => {
  let finish!: (accepted: boolean) => void;
  const onChange = vi.fn(), props = { value: "Original", onChange, pending: false, available: true,
    catalog: createCanonicalProviderCatalogFixture(), isCurrent: () => true,
    onSubmit: () => new Promise<boolean>(resolve => { finish = resolve; }) };
  const view = render(<ElectronBotCreationComposer {...props} scopeKey="a"/>);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  view.rerender(<ElectronBotCreationComposer {...props} scopeKey="b"/>);
  view.rerender(<ElectronBotCreationComposer {...props} scopeKey="a"/>);
  await act(async () => finish(true));
  expect(onChange).not.toHaveBeenCalled();
});
