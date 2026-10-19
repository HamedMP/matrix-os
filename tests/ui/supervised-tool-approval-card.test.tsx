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
  decline: true,
};

describe("Supervised tool approval card", () => {
  it("offers Allow once and Not now, and no chat-wide grant", () => {
    const onDecision = vi.fn();
    render(<SupervisedToolApprovalCard approval={waiting} onDecision={onDecision} />);
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("Nothing is sent or changed.", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow in this chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDecision.mock.calls.map((call) => call[0])).toEqual(["approve", "decline"]);
  });

  it("switches to Full access and approves the current request so the run continues", () => {
    const calls: string[] = [];
    const onDecision = vi.fn((decision: string) => { calls.push(`decision:${decision}`); });
    const onPermissionMode = vi.fn((mode: string) => { calls.push(`mode:${mode}`); });
    render(<SupervisedToolApprovalCard approval={waiting} permissionMode="supervised" onDecision={onDecision} onPermissionMode={onPermissionMode} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow → Full access" }));
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(calls).toEqual(["mode:full_access", "decision:approve"]);
    expect(screen.queryByRole("menu", { name: "Permission mode" })).toBeNull();
  });

  it("only closes the menu when the owner picks Supervised", () => {
    const onDecision = vi.fn();
    const onPermissionMode = vi.fn();
    render(<SupervisedToolApprovalCard approval={waiting} permissionMode="supervised" onDecision={onDecision} onPermissionMode={onPermissionMode} />);
    const trigger = screen.getByRole("button", { name: "Always allow → Full access" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Supervised/ }));
    expect(onDecision).not.toHaveBeenCalled();
    expect(onPermissionMode).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Permission mode" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not approve through Full access when Allow once is not offered", () => {
    const onDecision = vi.fn();
    const onPermissionMode = vi.fn();
    render(<SupervisedToolApprovalCard approval={{ ...waiting, allowOnce: false }} permissionMode="supervised" onDecision={onDecision} onPermissionMode={onPermissionMode} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow → Full access" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(onPermissionMode).toHaveBeenCalledWith("full_access");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("does not approve through Full access while a decision is already being sent", () => {
    const onDecision = vi.fn();
    const onPermissionMode = vi.fn();
    render(<SupervisedToolApprovalCard approval={waiting} submitting permissionMode="supervised" onDecision={onDecision} onPermissionMode={onPermissionMode} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow → Full access" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(onPermissionMode).toHaveBeenCalledWith("full_access");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("moves focus into the menu when it opens and back to its trigger after a choice", () => {
    render(<SupervisedToolApprovalCard approval={waiting} permissionMode="supervised" onDecision={vi.fn()} onPermissionMode={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Always allow → Full access" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: /Supervised/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Supervised/ }));
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the permission menu on Escape and returns focus to its trigger", () => {
    render(<SupervisedToolApprovalCard approval={waiting} permissionMode="supervised" onDecision={vi.fn()} onPermissionMode={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Always allow → Full access" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Permission mode" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Permission mode" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the permission menu when the owner clicks outside it", () => {
    const onPermissionMode = vi.fn();
    render(<div>
      <button type="button">Elsewhere</button>
      <SupervisedToolApprovalCard approval={waiting} permissionMode="supervised" onDecision={vi.fn()} onPermissionMode={onPermissionMode} />
    </div>);
    fireEvent.click(screen.getByRole("button", { name: "Always allow → Full access" }));
    fireEvent.pointerDown(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(screen.getByRole("menu", { name: "Permission mode" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu", { name: "Permission mode" })).toBeNull();
    expect(onPermissionMode).not.toHaveBeenCalled();
  });

  it("replaces an expired request with Try again and no allow buttons", () => {
    const onTryAgain = vi.fn();
    render(<SupervisedToolApprovalCard approval={{
      kind: "expired", title: "Search the web · “AI agent pricing”",
      summary: "No answer within 10 minutes, so nothing was searched.",
    }} onTryAgain={onTryAgain} />);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onTryAgain).toHaveBeenCalledWith("Try again: Search the web");
  });

  it("settles an allowed request into one line with no further actions", () => {
    render(<SupervisedToolApprovalCard approval={{ kind: "allowed", line: "Web search allowed" }} onDecision={vi.fn()} />);
    expect(screen.getByText("Web search allowed")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
