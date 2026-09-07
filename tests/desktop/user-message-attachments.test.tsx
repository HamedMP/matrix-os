// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessage } from "../../desktop/src/renderer/src/components/conversation/user-message";
import type { ConversationMessageContentPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";

afterEach(cleanup);

const image: ConversationMessageContentPresentation = {
  kind: "image", id: "image", label: "Screenshot.png", src: "/screenshot.png",
};
const file: ConversationMessageContentPresentation = {
  kind: "reference", referenceKind: "file", id: "file", label: "notes.txt", path: "temporary/notes.txt",
};

function show(content: ConversationMessageContentPresentation[], markdown = "") {
  return render(<UserMessage message={{
    kind: "message", id: "user", role: "user", phase: "commentary",
    timestamp: 1000, markdown, copyText: markdown, content,
  }} callbacks={{ copyText: vi.fn() }} />);
}

describe("attachment-only user messages", () => {
  it.each([ [image], [file], [image, file] ])("omits an empty text bubble for attachments %j", (...attachments) => {
    const { container } = show([...attachments, { kind: "text", text: " \n " }]);
    expect(screen.getByText(attachments[0].label)).toBeTruthy();
    expect(container.querySelector('[data-slot="bubble"]')).toBeNull();
    expect(container.querySelector('[data-slot="message-footer"]')).toBeTruthy();
  });

  it("preserves the text bubble alongside an attachment", () => {
    show([image, { kind: "text", text: "Review this screenshot" }], "Review this screenshot");
    expect(screen.getByText("Review this screenshot").closest('[data-slot="bubble"]')).toBeTruthy();
    expect(screen.getByRole("img", { name: "Screenshot.png" })).toBeTruthy();
  });

  it("preserves a resource-only bubble", () => {
    show([{ kind: "reference", referenceKind: "resource", id: "apps", label: "apps" }]);
    expect(screen.getByText("apps").closest('[data-slot="bubble"]')).toBeTruthy();
  });
});
