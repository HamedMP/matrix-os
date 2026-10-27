// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAgentDraftRequest } from "../../packages/ui/src/index.js";
import { ChatInput } from "../../shell/src/components/chat/ChatInput.js";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft.js";

function Composer({ request, onSubmit = vi.fn() }: { request: ChatAgentDraftRequest | null; onSubmit?: React.ComponentProps<typeof ChatInput>["onSubmit"] }) {
  const composer = useChatComposerDraft("new", "owner-1");
  return <ChatInput composer={composer} scope="new" permissionMode="supervised" connected busy={false}
    onSubmit={onSubmit} attachmentsEnabled={false} draftRequest={request} onDraftConsumed={vi.fn()} />;
}

const value = () => (screen.getByPlaceholderText("Ask anything...") as HTMLTextAreaElement).value;

afterEach(cleanup);

describe("chat input draft requests", () => {
  it.each([false, true])("acknowledges a late Web send only for its unchanged draft (edited=%s)", async edited => {
    let acknowledged: (() => void) | undefined;
    const onSubmit = vi.fn(async (_text, _files, options) => { acknowledged = options?.onAccepted; return false; });
    render(<Composer request={null} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText("Ask anything..."), { target: { value: "original draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(value()).toBe("original draft");
    expect(acknowledged).toBeTypeOf("function");
    if (edited) fireEvent.change(screen.getByPlaceholderText("Ask anything..."), { target: { value: "new unsent draft" } });
    act(() => { acknowledged!(); acknowledged!(); });
    expect(value()).toBe(edited ? "new unsent draft" : "");
  });
  it("fills an empty composer and swaps an untouched earlier suggestion", () => {
    const view = render(<Composer request={{ id: 1, text: "Find emails that need a reply.", merge: true }} />);
    expect(value()).toBe("Find emails that need a reply.");
    view.rerender(<Composer request={{ id: 2, text: "List my GitHub repos.", merge: true }} />);
    expect(value()).toBe("List my GitHub repos.");
  });

  it("keeps what the owner typed and adds the suggestion below it", () => {
    const view = render(<Composer request={null} />);
    fireEvent.change(screen.getByPlaceholderText("Ask anything..."), { target: { value: "my unsent idea" } });
    view.rerender(<Composer request={{ id: 2, text: "Find emails that need a reply.", merge: true }} />);
    expect(value()).toBe("my unsent idea\n\nFind emails that need a reply.");
    view.rerender(<Composer request={{ id: 3, text: "Replace it." }} />);
    expect(value()).toBe("Replace it.");
  });

  it("keeps what the owner typed when Try is clicked twice", () => {
    const view = render(<Composer request={null} />);
    fireEvent.change(screen.getByPlaceholderText("Ask anything..."), { target: { value: "my unsent idea" } });
    view.rerender(<Composer request={{ id: 2, text: "Find emails that need a reply.", merge: true }} />);
    view.rerender(<Composer request={{ id: 3, text: "List my GitHub repos.", merge: true }} />);
    expect(value()).toBe("my unsent idea\n\nList my GitHub repos.");
  });
});
