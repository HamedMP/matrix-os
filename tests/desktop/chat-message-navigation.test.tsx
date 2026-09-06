// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageResponse } from "@desktop/renderer/src/components/conversation/message";
import { ConversationTranscript } from "@desktop/renderer/src/components/conversation/transcript";
import { resolveChatMessageLink } from "@matrix-os/contracts";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("classifies links consistently and rejects unsafe file and protocol inputs", () => {
  expect(resolveChatMessageLink("https://example.com")).toEqual({ kind: "web", url: "https://example.com/" });
  expect(resolveChatMessageLink("/home/matrix/home/reports/file.md:12")).toEqual({ kind: "file", path: "reports/file.md" });
  for (const input of ["javascript:alert(1)", "../secrets", "file:///etc/passwd", "https://user:password@example.com"]) expect(resolveChatMessageLink(input)).toBeNull();
});

it("routes web links and file references through separate Chat actions", () => {
  const openFile = vi.fn(() => true);
  const openWebLink = vi.fn(() => true);
  render(<MessageResponse copyText={vi.fn()} openFile={openFile} openWebLink={openWebLink}>
    {"[Website](https://example.com/docs) and [Report](reports/result.md)"}
  </MessageResponse>);
  fireEvent.click(screen.getByRole("link", { name: "Website" }));
  expect(openWebLink).toHaveBeenCalledWith("https://example.com/docs");
  expect(openFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "Report" }));
  expect(openFile).toHaveBeenCalledWith("reports/result.md");
});

it("shows a retryable image failure instead of loading forever", async () => {
  const loadImage = vi.fn(async () => { throw new Error("Missing"); });
  render(<ConversationTranscript callbacks={{ copyText: vi.fn(), loadImage }} turns={[{
    id: "turn", startedAt: 1, endedAt: 2, active: false, work: [],
    user: { kind: "message", id: "message", role: "user", phase: "final", markdown: "", copyText: "", timestamp: 1,
      content: [{ kind: "image", id: "attachment", label: "Image.png", src: "/api/files/blob?path=uploads/image.png" }],
    },
  }]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry Image.png" }));
  expect(loadImage).toHaveBeenCalledTimes(2);
});

it("opens an attached file using its owner reference instead of its display label", () => {
  const openAttachment = vi.fn(() => true);
  render(<ConversationTranscript callbacks={{ copyText: vi.fn(), openAttachment }} turns={[{
    id: "turn", startedAt: 1, endedAt: 2, active: false, work: [],
    user: { kind: "message", id: "message", role: "user", phase: "final", markdown: "", copyText: "", timestamp: 1,
      content: [{ kind: "reference", id: "attachment", referenceKind: "file", label: "Report.pdf", path: "uploads/report.pdf" }],
    },
  }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview Report.pdf" }));
  expect(openAttachment).toHaveBeenCalledWith("uploads/report.pdf");
});
