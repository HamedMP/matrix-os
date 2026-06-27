// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
let socketHandler: ((msg: unknown) => void) | null = null;

vi.mock("../../shell/src/hooks/useSocket.js", () => ({
  useSocket: () => ({
    subscribe: (handler: (msg: unknown) => void) => {
      socketHandler = handler;
      return () => {
        socketHandler = null;
      };
    },
    send: sendMock,
  }),
}));

import { ApprovalDialog } from "../../shell/src/components/ApprovalDialog.js";

describe("ApprovalDialog", () => {
  beforeEach(() => {
    sendMock.mockReset();
    socketHandler = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("does not reopen an already-seen replayed approval request", async () => {
    render(<ApprovalDialog />);

    await act(async () => {
      socketHandler?.({
        type: "approval:request",
        id: "approval-1",
        eventId: "sess-1:approval:approval-1",
        toolName: "Write",
        args: { path: "file.txt" },
        timeout: 30_000,
      });
    });

    expect(screen.getByText("Approval Required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sendMock).toHaveBeenCalledWith({
      type: "approval_response",
      id: "approval-1",
      approved: true,
    });

    await act(async () => {
      socketHandler?.({
        type: "approval:request",
        id: "approval-1",
        eventId: "sess-1:approval:approval-1",
        toolName: "Write",
        args: { path: "file.txt" },
        timeout: 30_000,
      });
    });

    expect(screen.queryByText("Approval Required")).toBeNull();
  });
});
