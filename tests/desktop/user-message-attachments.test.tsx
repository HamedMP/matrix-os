// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("renders each attachment once while a long mixed message is collapsed or expanded", () => {
    const markdown = "Long message. ".repeat(70);
    render(<UserMessage message={{
      kind: "message", id: "mixed", role: "user", phase: "commentary", timestamp: 1000,
      markdown, copyText: markdown, content: [file, { kind: "text", text: markdown }],
      references: [{ id: "file", kind: "file", label: "notes.txt" }],
    }} callbacks={{ copyText: vi.fn() }} />);
    expect(screen.getAllByText("notes.txt")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show full message" }));
    expect(screen.getAllByText("notes.txt")).toHaveLength(1);
  });
});

describe("user message Markdown", () => {
  it("renders formatting and links inside the user bubble", () => {
    const markdown = "**Important**: read [the guide](https://example.com/guide) and `run test`.";
    const { container } = show([{ kind: "text", text: markdown }], markdown);
    const bubble = container.querySelector('[data-slot="bubble"]')!;
    expect(bubble.querySelector("strong")?.textContent).toBe("Important");
    expect(bubble.querySelector("code")?.textContent).toBe("run test");
    expect(screen.getByRole("link", { name: "the guide" }).getAttribute("href"))
      .toBe("https://example.com/guide");
    expect(bubble.textContent).not.toContain("**Important**");
  });

  it("keeps complete Markdown markup when a long message expands", () => {
    const markdown = `${"An introduction. ".repeat(50)}\n\n**Final point**`;
    const { container } = show([{ kind: "text", text: markdown }], markdown);
    expect(screen.getByRole("button", { name: "Show full message" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("Final point");
    fireEvent.click(screen.getByRole("button", { name: "Show full message" }));
    expect(container.querySelector("strong")?.textContent).toBe("Final point");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("keeps reference chips between formatted text segments", () => {
    const markdown = "**Review** [the file](resource-id) next";
    const { container } = show([
      { kind: "text", text: "**Review** " },
      { kind: "reference", referenceKind: "resource", id: "resource-id", label: "the file" },
      { kind: "text", text: " next" },
    ], markdown);
    expect(container.querySelector("strong")?.textContent).toBe("Review");
    expect(screen.getByText("the file")).toBeTruthy();
    expect(container.querySelector('[data-slot="bubble"]')?.textContent).toContain("next");
  });

  it("preserves Markdown formatting that surrounds a reference chip", () => {
    const markdown = "**open [the file](resource-id)** next";
    const { container } = show([
      { kind: "text", text: "**open " },
      { kind: "reference", referenceKind: "resource", id: "resource-id", label: "the file" },
      { kind: "text", text: "** next" },
    ], markdown);
    expect(container.querySelector("strong")?.textContent).toBe("open the file");
    expect(screen.getByText("the file").closest("strong")).toBeTruthy();
  });

  it("uses current reference data when an existing message updates in place", () => {
    const renderMessage = (id: string, label: string) => <UserMessage message={{
      kind: "message", id: "updating", role: "user", phase: "commentary", timestamp: 1000,
      markdown: `**open [${label}](${id})**`, copyText: `**open [${label}](${id})**`,
      content: [
        { kind: "text", text: "**open " },
        { kind: "reference", referenceKind: "resource", id, label },
        { kind: "text", text: "**" },
      ],
    }} callbacks={{ copyText: vi.fn() }} />;
    const { rerender, container } = render(renderMessage("first", "first file"));
    expect(container.querySelector("strong")?.textContent).toBe("open first file");

    rerender(renderMessage("second", "second file"));
    expect(container.querySelector("strong")?.textContent).toBe("open second file");
    expect(screen.queryByText("first file")).toBeNull();
  });

  it("preserves Markdown control state when an unchanged message rerenders", () => {
    const renderMessage = () => <UserMessage message={{
      kind: "message", id: "stable", role: "user", phase: "commentary", timestamp: 1000,
      markdown: "```text\nlong code line\n```\n\n[the file](resource-id)",
      copyText: "```text\nlong code line\n```\n\n[the file](resource-id)",
      content: [
        { kind: "text", text: "```text\nlong code line\n```\n\n" },
        { kind: "reference", referenceKind: "resource", id: "resource-id", label: "the file" },
      ],
    }} callbacks={{ copyText: vi.fn() }} />;
    const { rerender } = render(renderMessage());
    fireEvent.click(screen.getByRole("button", { name: "Wrap code block" }));
    expect(screen.getByRole("button", { name: "Disable code wrapping" }).getAttribute("aria-pressed")).toBe("true");

    rerender(renderMessage());
    expect(screen.getByRole("button", { name: "Disable code wrapping" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps controls in a collapsed long message out of keyboard navigation", () => {
    const markdown = `${"Introduction. ".repeat(65)} [hidden link](https://example.com)`;
    const { container } = show([{ kind: "text", text: markdown }], markdown);
    expect(container.querySelector('[data-message-preview-content]')?.hasAttribute("inert")).toBe(true);
    expect(screen.getByText(/Message preview:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show full message" }));
    expect(container.querySelector('[data-message-preview-content]')?.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("link", { name: "hidden link" })).toBeTruthy();
  });
});
