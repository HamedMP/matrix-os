// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentThreadSnapshot } from "@matrix-os/contracts";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";

afterEach(cleanup);

function requestedApprovalSnapshot(): AgentThreadSnapshot {
  return {
    thread: {
      id: "thread_alpha",
      providerId: "codex",
      title: "Fix settings route",
      status: "waiting_for_approval",
      attention: "approval_required",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:04:00.000Z",
    },
    events: {
      items: [
        {
          type: "approval.requested",
          eventId: "evt_approval_desktop_1",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:03:00.000Z",
          approval: {
            approvalId: "appr_desktop_1",
            threadId: "thread_alpha",
            actionKind: "command",
            risk: "medium",
            title: "Run tests",
            safeDescription: "Run the focused desktop tests.",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_desktop_1",
          },
        },
      ],
      hasMore: false,
      limit: 200,
    },
  } as AgentThreadSnapshot;
}

function resolvedApprovalSnapshot(): AgentThreadSnapshot {
  const base = requestedApprovalSnapshot();
  return {
    ...base,
    thread: {
      ...base.thread,
      status: "running",
      attention: "none",
      updatedAt: "2026-07-06T00:05:00.000Z",
    },
    events: {
      ...base.events,
      items: [
        ...base.events.items,
        {
          type: "approval.resolved",
          eventId: "evt_approval_desktop_2",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:05:00.000Z",
          approvalId: "appr_desktop_1",
          decision: "approve",
        },
      ],
    },
  } as AgentThreadSnapshot;
}

describe("AgentConversationView approvals", () => {
  it("renders decision buttons for a pending approval request", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={requestedApprovalSnapshot()}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByRole("button", { name: /approve run tests/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /decline run tests/i })).toBeTruthy();
  });

  it("suppresses decision buttons for approvals already resolved in the snapshot", () => {
    render(
      <AgentConversationView
        status="ready"
        snapshot={resolvedApprovalSnapshot()}
        error={null}
        canSendTurns
      />,
    );

    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Approval resolved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve run tests/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /decline run tests/i })).toBeNull();
  });
});
