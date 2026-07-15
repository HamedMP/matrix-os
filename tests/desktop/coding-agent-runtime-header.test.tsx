// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { AgentRuntimeHeader } from "../../desktop/src/renderer/src/features/coding-agents/AgentRuntimeHeader";

function summary(status: RuntimeSummary["runtime"]["status"]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: `Runtime ${status}`, status },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16_384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8_192,
      maxListItems: 20,
    },
    serverTime: "2026-07-10T12:00:00.000Z",
  };
}

function statusColor(status: RuntimeSummary["runtime"]["status"]): string {
  render(<AgentRuntimeHeader summary={summary(status)} onRefresh={vi.fn()} />);
  const label = screen.getByText(`Runtime ${status}`);
  const dot = label.parentElement?.querySelector<HTMLSpanElement>("span.inline-block");
  return dot?.style.background ?? "";
}

describe("AgentRuntimeHeader", () => {
  afterEach(cleanup);

  it.each([
    ["running", "var(--success)"],
    ["failed", "var(--danger)"],
    ["unavailable", "var(--danger)"],
  ] as const)("preserves the %s runtime status color", (status, expected) => {
    expect(statusColor(status)).toBe(expected);
  });
});
