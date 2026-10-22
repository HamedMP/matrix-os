// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CanonicalApprovalMessage } from "../../shell/src/components/chat/CanonicalApprovalMessage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("handles a rejected generic approval without an unhandled rejection", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const message = { id: "message_test", role: "system" as const, content: "Review action", timestamp: Date.now(), metadata: {
    canonicalApproval: { runId: "run_test", approvalId: "approval_test", title: "Review action", description: "Run a test command",
      risk: "medium", allowedDecisions: ["approve", "decline", "cancel"], pending: true },
  } };
  const onSubmit = vi.fn(async () => { throw new Error("Synthetic rejected approval"); });
  render(<CanonicalApprovalMessage message={message} submitting={false} onSubmit={onSubmit}/>);
  fireEvent.click(screen.getByRole("button", { name: "Approve", exact: true }));
  await screen.findByRole("alert");
  expect(onSubmit).toHaveBeenCalledWith("run_test", "approval_test", "approve");
  expect(screen.getByText("Could not submit approval. Try again.")).toBeTruthy();
  expect(screen.queryByText("Synthetic rejected approval")).toBeNull();
});
