// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupervisedToolApprovalCard } from "../../packages/ui/src/chat/SupervisedToolApprovalCard";
import type { SupervisedToolApproval } from "../../packages/contracts/src/supervised-tool-approval";

const waiting: SupervisedToolApproval = {
  kind: "waiting",
  title: "Search the web · “AI agent pricing”",
  summary: "Matrix wants to search the web and read a few pages to write your brief. Nothing is sent or changed.",
  details: "{\"query\":\"AI agent pricing\"}",
  bar: "Search the web",
  allowOnce: true,
  allowInChat: true,
  decline: true,
};

describe("Supervised tool approval card", () => {
  it("offers Allow once, Allow in this chat, and Not now", () => {
    const onDecision = vi.fn();
    render(<SupervisedToolApprovalCard approval={waiting} onDecision={onDecision} />);
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("Nothing is sent or changed.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow in this chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDecision.mock.calls.map((call) => call[0])).toEqual(["approve", "approve_for_session", "decline"]);
  });

  it("opens Full access without approving the current tool", () => {
    const onDecision = vi.fn();
    const onPermissionMode = vi.fn();
    render(<SupervisedToolApprovalCard approval={waiting} permissionMode="supervised" onDecision={onDecision} onPermissionMode={onPermissionMode} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow → Full access" }));
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(onPermissionMode).toHaveBeenCalledWith("full_access");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("replaces an expired request with Try again and no allow buttons", () => {
    const onTryAgain = vi.fn();
    render(<SupervisedToolApprovalCard approval={{
      kind: "expired", title: "Search the web · “AI agent pricing”",
      summary: "No answer within 10 minutes, so nothing was searched.",
    }} onTryAgain={onTryAgain} />);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onTryAgain).toHaveBeenCalledOnce();
  });

  it("offers Undo only for a chat grant", () => {
    const onDecision = vi.fn();
    render(<SupervisedToolApprovalCard approval={{ kind: "allowed", line: "Web search allowed in this chat", undo: true }} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onDecision).toHaveBeenCalledWith("decline");
  });

  it("hides Undo after the chat grant is revoked", () => {
    render(<SupervisedToolApprovalCard approval={{ kind: "allowed", line: "Web search allowed in this chat", undo: false }} onDecision={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
