// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatCredentialDisclosure } from "@desktop/renderer/src/features/chat/ChatCredentialDisclosure";
import { MessageResponse } from "@desktop/renderer/src/components/conversation/message";
import { ConversationTranscript } from "@desktop/renderer/src/components/conversation/transcript";

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});
afterEach(cleanup);

const first = { id: "cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", messageId: "msg_one", offset: 6, length: 21, revealed: false };
const second = { id: "cred_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", messageId: "msg_one", offset: 39, length: 10, revealed: false };
const markdown = "token=[redacted credential] and Bearer [redacted]";

function InlineMessage({ occurrences = [first, second], values = {}, loaded = true, enabled = true, onReveal = vi.fn(), onHide = vi.fn(), text = markdown }: {
  occurrences?: typeof first[]; values?: Record<string, string>; loaded?: boolean; enabled?: boolean;
  onReveal?: (id: string) => Promise<unknown>; onHide?: (id: string) => Promise<unknown>; text?: string;
}) {
  return <MessageResponse copyText={vi.fn()} renderCredentialMarker={enabled ? (offset, marker, number) => (
    <ChatCredentialDisclosure marker={marker} number={number} loaded={loaded}
      occurrence={occurrences.find((item) => item.offset === offset && item.length === marker.length)}
      value={values[occurrences.find((item) => item.offset === offset)?.id ?? ""]}
      onReveal={onReveal} onHide={onHide} />
  ) : undefined}>{text}</MessageResponse>;
}

describe("inline Chat credential disclosure", () => {
  it("toggles each exact marker in place without a separate disclosure row", async () => {
    const onReveal = vi.fn(async () => "private-test-value");
    const onHide = vi.fn(async () => undefined);
    const view = render(<InlineMessage onReveal={onReveal} onHide={onHide} />);
    expect(screen.queryByText("private-test-value")).toBeNull();
    expect(screen.queryByText(/Credential 1/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal credential 1" }));
    await waitFor(() => expect(onReveal).toHaveBeenCalledWith(first.id));
    view.rerender(<InlineMessage occurrences={[{ ...first, revealed: true }, second]} values={{ [first.id]: "private-test-value" }} onReveal={onReveal} onHide={onHide} />);
    expect(screen.getByRole("button", { name: "Hide credential 1" }).textContent).toBe("private-test-value");
    expect(screen.getByRole("button", { name: "Reveal credential 2" }).textContent).toBe("[redacted]");
    fireEvent.click(screen.getByRole("button", { name: "Hide credential 1" }));
    await waitFor(() => expect(onHide).toHaveBeenCalledWith(first.id));
  });

  it("preserves Markdown around duplicate markers and uses their exact offsets", () => {
    const text = "**token=[redacted credential]** and *token=[redacted credential]*";
    const offsets = [...text.matchAll(/\[redacted credential\]/g)].map((match) => match.index);
    const occurrences = offsets.map((offset, index) => ({ ...first, id: `${first.id}${index}`, offset }));
    render(<InlineMessage text={text} occurrences={occurrences} />);
    const buttons = screen.getAllByRole("button", { name: /Reveal credential/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.closest("strong")).toBeTruthy();
    expect(buttons[1]?.closest("em")).toBeTruthy();
  });

  it("maps Unicode source offsets and waits for a complete streamed marker", () => {
    const text = "🙂 token=[redacted credential]";
    const occurrence = { ...first, offset: text.indexOf("[redacted credential]") };
    const view = render(<InlineMessage text="🙂 token=[redac" occurrences={[occurrence]} />);
    expect(screen.queryByRole("button", { name: /Reveal credential/ })).toBeNull();
    view.rerender(<InlineMessage text={text} occurrences={[occurrence]} />);
    expect(screen.getByRole("button", { name: "Reveal credential 1" })).toBeTruthy();
  });

  it("keeps a marker inside inline code clickable", () => {
    const text = "Run `API_KEY=[redacted credential]` now";
    render(<MessageResponse copyText={vi.fn()} renderCredentialMarker={(position, marker, number) => (
      <ChatCredentialDisclosure marker={marker} number={number} loaded occurrence={{ ...first, offset: position }}
        onReveal={vi.fn()} onHide={vi.fn()} />
    )}>{text}</MessageResponse>);
    expect(screen.getByRole("button", { name: "Reveal credential 1" }).closest("code")).toBeTruthy();
  });

  it("shows a credential in a code block in place while its Copy action stays masked", async () => {
    const text = "```sh\nAPI_KEY=[redacted credential]\n```";
    const copyText = vi.fn(async () => undefined);
    const offset = text.indexOf("[redacted credential]");
    render(<MessageResponse copyText={copyText} renderCredentialMarker={(position, marker, number) => (
      <ChatCredentialDisclosure marker={marker} number={number} loaded
        occurrence={position === offset ? { ...first, offset } : undefined}
        onReveal={vi.fn()} onHide={vi.fn()} />
    )}>{text}</MessageResponse>);
    expect(screen.getByRole("button", { name: "Reveal credential 1" }).closest("pre")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("API_KEY=[redacted credential]"));
  });

  it("copies canonical markers from a table even when a cell is revealed", async () => {
    const copyText = vi.fn(async () => undefined);
    const text = "| Key | Value |\n| --- | --- |\n| API_KEY | [redacted credential] |";
    const offset = text.indexOf("[redacted credential]");
    render(<MessageResponse copyText={copyText} renderCredentialMarker={(position, marker, number) => (
      <ChatCredentialDisclosure marker={marker} number={number} loaded
        occurrence={position === offset ? { ...first, offset, revealed: true } : undefined}
        value="private-test-value" onReveal={vi.fn()} onHide={vi.fn()} />
    )}>{text}</MessageResponse>);
    expect(screen.getByRole("button", { name: "Hide credential 1" }).textContent).toBe("private-test-value");
    fireEvent.click(screen.getByRole("button", { name: "Copy table as Markdown" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(expect.stringContaining("[redacted credential]")));
    expect(copyText.mock.calls[0]?.[0]).not.toContain("private-test-value");
  });

  it("leaves markers in Markdown links and image alt text masked without nested buttons", () => {
    const text = "[token=[redacted credential]](https://example.com) ![icon [redacted credential]](https://example.com/a.png)";
    const offsets = [...text.matchAll(/\[redacted credential\]/g)].map((match) => match.index);
    const occurrences = offsets.map((offset, index) => ({ ...first, id: `${first.id}${index}`, offset }));
    const { container } = render(<InlineMessage text={text} occurrences={occurrences} />);
    expect(container.querySelector("a")).toBeTruthy();
    expect(container.querySelector("img")).toBeTruthy();
    expect(container.querySelector("a button, img button")).toBeNull();
    expect(screen.queryByRole("button", { name: /Reveal credential/ })).toBeNull();
  });

  it("does not attach a control when the server offset does not match the marker", () => {
    render(<InlineMessage occurrences={[{ ...first, offset: 7 }]} />);
    expect(screen.queryByRole("button", { name: "Reveal credential 1" })).toBeNull();
    expect(screen.getByText("[redacted credential]")).toBeTruthy();
  });

  it("keeps historical markers non-clickable and explains their unavailability", () => {
    render(<InlineMessage occurrences={[]} text="api_key=[redacted credential]" />);
    expect(screen.queryByRole("button", { name: /Reveal credential/ })).toBeNull();
    expect(screen.getByTitle(/Previously redacted values cannot be recovered/)).toBeTruthy();
  });

  it("does not label a temporary metadata failure as irrecoverable history", () => {
    render(<MessageResponse copyText={vi.fn()} renderCredentialMarker={(_offset, marker, number) => (
      <ChatCredentialDisclosure marker={marker} number={number} loaded availabilityFailed
        onReveal={vi.fn()} onHide={vi.fn()} />
    )}>{"api_key=[redacted credential]"}</MessageResponse>);
    expect(screen.getByTitle("Credential availability is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByTitle(/Previously redacted/)).toBeNull();
  });

  it("removes plaintext when the owner-private scope is lost", () => {
    const view = render(<InlineMessage text="token=[redacted credential]" occurrences={[{ ...first, revealed: true }]} values={{ [first.id]: "private-test-value" }} />);
    expect(screen.getByText("private-test-value")).toBeTruthy();
    view.rerender(<InlineMessage text="token=[redacted credential]" occurrences={[{ ...first, revealed: true }]} values={{ [first.id]: "private-test-value" }} enabled={false} />);
    expect(screen.queryByText("private-test-value")).toBeNull();
    expect(screen.getByText("token=[redacted credential]")).toBeTruthy();
  });

  it("keeps hide actionable when rehydration fails", async () => {
    const onHide = vi.fn(async () => undefined);
    render(<InlineMessage text="token=[redacted credential]" occurrences={[{ ...first, revealed: true }]} onHide={onHide} />);
    expect(screen.getByText("Credential unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide credential 1" }));
    await waitFor(() => expect(onHide).toHaveBeenCalledWith(first.id));
  });

  it("keeps the assistant message Copy action on canonical masked text after inline reveal", async () => {
    const copyText = vi.fn(async () => undefined);
    const turn = { id: "turn_one", startedAt: 100, endedAt: 200, active: false, work: [], final: {
      kind: "message" as const, id: "msg_one", role: "assistant" as const, phase: "final" as const,
      markdown: "token=[redacted credential]", copyText: "token=[redacted credential]", timestamp: 200,
    } };
    render(<ConversationTranscript turns={[turn]} callbacks={{
      copyText,
      renderCredentialMarker: (_message, _offset, marker, number) => <ChatCredentialDisclosure
        marker={marker} number={number} loaded occurrence={{ ...first, revealed: true }}
        value="private-test-value" onReveal={vi.fn()} onHide={vi.fn()} />,
    }} />);
    expect(screen.getByRole("button", { name: "Hide credential 1" }).textContent).toBe("private-test-value");
    fireEvent.click(screen.getByRole("button", { name: "Copy assistant message" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("token=[redacted credential]"));
  });
});
