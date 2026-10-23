// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAgentDraftRequest } from "../../packages/ui/src/index.js";
import { ChatInput } from "../../shell/src/components/chat/ChatInput.js";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft.js";

function Composer({ request }: { request: ChatAgentDraftRequest | null }) {
  const composer = useChatComposerDraft("new", "owner-1");
  return <ChatInput composer={composer} scope="new" permissionMode="supervised" connected busy={false}
    onSubmit={vi.fn()} attachmentsEnabled={false} draftRequest={request} onDraftConsumed={vi.fn()} />;
}

afterEach(cleanup);

describe("chat input draft requests", () => {
  it("fills an empty composer with a requested prompt", () => {
    render(<Composer request={{ id: 1, text: "Find emails that need a reply.", keepExisting: true }} />);
    expect((screen.getByPlaceholderText("Ask anything...") as HTMLTextAreaElement).value).toBe("Find emails that need a reply.");
  });

  it("keeps what the owner already typed when the request asks to", () => {
    const view = render(<Composer request={null} />);
    fireEvent.change(screen.getByPlaceholderText("Ask anything..."), { target: { value: "my unsent idea" } });
    view.rerender(<Composer request={{ id: 2, text: "Find emails that need a reply.", keepExisting: true }} />);
    expect((screen.getByPlaceholderText("Ask anything...") as HTMLTextAreaElement).value).toBe("my unsent idea");
    view.rerender(<Composer request={{ id: 3, text: "Replace it." }} />);
    expect((screen.getByPlaceholderText("Ask anything...") as HTMLTextAreaElement).value).toBe("Replace it.");
  });
});
