// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatCredentialDisclosure } from "@desktop/renderer/src/features/chat/ChatCredentialDisclosure";

afterEach(cleanup);

const occurrences = [
  { id: "cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", messageId: "msg_one", offset: 12, length: 21, revealed: false },
  { id: "cred_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", messageId: "msg_one", offset: 50, length: 10, revealed: false },
];

describe("ChatCredentialDisclosure", () => {
  it("reveals one credential in a separate accessible area and hides it manually", async () => {
    const onReveal = vi.fn(async () => "private-test-value");
    const onHide = vi.fn(async () => undefined);
    const view = render(<ChatCredentialDisclosure messageId="msg_one" markdown="token=[redacted credential] and Bearer [redacted]"
      occurrences={occurrences} values={{}} loaded onReveal={onReveal} onHide={onHide} />);

    expect(screen.queryByText("private-test-value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal credential 1" }));
    await waitFor(() => expect(onReveal).toHaveBeenCalledWith("cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));

    view.rerender(<ChatCredentialDisclosure messageId="msg_one" markdown="token=[redacted credential] and Bearer [redacted]"
      occurrences={[{ ...occurrences[0]!, revealed: true }, occurrences[1]!]} values={{ cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "private-test-value" }} loaded
      onReveal={onReveal} onHide={onHide} />);
    expect(screen.getByText("private-test-value")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide credential 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal credential 2" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide credential 1" }));
    await waitFor(() => expect(onHide).toHaveBeenCalledWith("cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  });

  it("explains historical redaction only after metadata was checked", () => {
    const props = { messageId: "msg_old", markdown: "api_key=[redacted credential]", occurrences: [], values: {}, onReveal: vi.fn(), onHide: vi.fn() };
    const view = render(<ChatCredentialDisclosure {...props} loaded={false} />);
    expect(screen.queryByText(/cannot be revealed/i)).toBeNull();
    view.rerender(<ChatCredentialDisclosure {...props} loaded />);
    expect(screen.getByText(/cannot be revealed/i)).toBeTruthy();
  });

  it("never leaves a value visible when the owner-private scope is lost", () => {
    const props = { messageId: "msg_one", markdown: "token=[redacted credential]", occurrences: [{ ...occurrences[0]!, revealed: true }],
      values: { cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "private-test-value" }, loaded: true, onReveal: vi.fn(), onHide: vi.fn() };
    const view = render(<ChatCredentialDisclosure {...props} enabled />);
    expect(screen.getByText("private-test-value")).toBeTruthy();
    view.rerender(<ChatCredentialDisclosure {...props} enabled={false} />);
    expect(screen.queryByText("private-test-value")).toBeNull();
  });

  it("shows a safe unavailable state and keeps manual hide actionable when rehydration fails", async () => {
    const onHide = vi.fn(async () => undefined);
    render(<ChatCredentialDisclosure messageId="msg_one" markdown="token=[redacted credential]"
      occurrences={[{ ...occurrences[0]!, revealed: true }]} values={{}} unavailableIds={["cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]} loaded
      onReveal={vi.fn()} onHide={onHide} />);
    expect(screen.getByText("Credential unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide credential 1" }));
    await waitFor(() => expect(onHide).toHaveBeenCalledWith("cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  });
});
