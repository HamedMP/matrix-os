import { describe, expect, it } from "vitest";
import type { AgentThreadSummary, ReviewSummary, RuntimeSummary, TerminalRef } from "@matrix-os/contracts";
import { buildProjectInspectorContext } from "../../desktop/src/renderer/src/features/project/project-inspector-context";

const NOW = "2026-08-18T12:00:00.000Z";
const MATRIX_WORKSPACE_ID = "tws_00000000000000000000000000000001";
const MATRIX_TAB_ID = "tt_00000000000000000000000000000001";
const OTHER_WORKSPACE_ID = "tws_00000000000000000000000000000002";
const OTHER_TAB_ID = "tt_00000000000000000000000000000002";

function thread(id: string, projectId: string, terminalRef?: TerminalRef): AgentThreadSummary {
  return {
    id,
    providerId: "codex",
    title: id,
    status: "running",
    attention: "none",
    projectId,
    terminalRef,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function summary(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [
      { id: "codingAgentsReview", enabled: true },
      { id: "codingAgentsPreview", enabled: true },
      { id: "codingAgentsFiles", enabled: true },
    ],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: {
      items: [
        thread("thread_matrix", "matrix-os", { workspaceId: MATRIX_WORKSPACE_ID, tabId: MATRIX_TAB_ID }),
        thread("thread_other", "website", { workspaceId: OTHER_WORKSPACE_ID, tabId: OTHER_TAB_ID }),
      ],
      hasMore: false,
      limit: 20,
    },
    attentionThreads: {
      items: [{ ...thread("thread_attention", "matrix-os"), attention: "input_required" }],
      hasMore: false,
      limit: 20,
    },
    terminalWorkspaces: {
      items: [
        {
          id: MATRIX_WORKSPACE_ID,
          scope: "project",
          projectId: "matrix-os",
          canonicalSize: { cols: 120, rows: 40 },
          status: "running",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          tabs: [{
            id: MATRIX_TAB_ID,
            workspaceId: MATRIX_WORKSPACE_ID,
            name: "matrix",
            cwd: "projects/matrix-os",
            status: "running",
            revision: 1,
            order: 0,
            createdAt: NOW,
            updatedAt: NOW,
          }],
        },
        {
          id: OTHER_WORKSPACE_ID,
          scope: "project",
          projectId: "website",
          canonicalSize: { cols: 120, rows: 40 },
          status: "running",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          tabs: [{
            id: OTHER_TAB_ID,
            workspaceId: OTHER_WORKSPACE_ID,
            name: "website",
            cwd: "projects/website",
            status: "running",
            revision: 1,
            order: 0,
            createdAt: NOW,
            updatedAt: NOW,
          }],
        },
      ],
      hasMore: false,
      limit: 20,
    },
    previewSessions: {
      items: [
        { id: "preview_matrix", projectId: "matrix-os", label: "Matrix", status: "running", updatedAt: NOW },
        { id: "preview_other", projectId: "website", label: "Website", status: "running", updatedAt: NOW },
        { id: "preview_global", label: "Unknown scope", status: "running", updatedAt: NOW },
      ],
      hasMore: false,
      limit: 50,
    },
    recentActivity: {
      items: [{ id: "evt_global", kind: "provider", label: "Provider changed", occurredAt: NOW }],
      hasMore: false,
      limit: 20,
    },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function review(id: string, projectId: string): ReviewSummary {
  return {
    id,
    projectId,
    worktreeId: "wt_main",
    status: "reviewing",
    pullRequestNumber: 1,
    round: 1,
    maxRounds: 3,
    reviewer: "codex",
    implementer: "codex",
    updatedAt: NOW,
  };
}

describe("buildProjectInspectorContext", () => {
  it("scopes reviews, previews, activity, and terminal sessions to the selected project thread", () => {
    const runtime = summary();
    const selectedThread = runtime.activeThreads.items[0]!;
    const context = buildProjectInspectorContext({
      projectId: "matrix-os",
      summary: runtime,
      selectedThread,
      reviews: [review("rev_matrix", "matrix-os"), review("rev_other", "website")],
    });

    expect(context.reviews.map((item) => item.id)).toEqual(["rev_matrix"]);
    expect(context.summary.previewSessions.items.map((item) => item.id)).toEqual(["preview_matrix"]);
    expect(context.summary.activeThreads.items.map((item) => item.id)).toEqual(["thread_matrix"]);
    expect(context.summary.attentionThreads.items.map((item) => item.id)).toEqual(["thread_attention"]);
    expect(context.summary.terminalWorkspaces.items.map((item) => item.id)).toEqual([MATRIX_WORKSPACE_ID]);
    expect(context.summary.terminalWorkspaces.items[0]?.tabs.map((item) => item.id)).toEqual([MATRIX_TAB_ID]);
    expect(context.summary.recentActivity.items).toEqual([]);
    expect(context.terminalState).toBe("linked");
    expect(context.counts).toEqual({ changes: 1, files: undefined, terminal: 1, preview: 1, activity: 2 });
    expect(context.defaultTab).toBe("changes");
  });

  it("does not fall back to unrelated terminal sessions when the selected thread has no live binding", () => {
    const context = buildProjectInspectorContext({
      projectId: "matrix-os",
      summary: summary(),
      selectedThread: thread("thread_missing", "matrix-os", {
        workspaceId: MATRIX_WORKSPACE_ID,
        tabId: "tt_00000000000000000000000000000003",
      }),
      reviews: [],
    });

    expect(context.summary.terminalWorkspaces.items).toEqual([]);
    expect(context.terminalState).toBe("unavailable");
    expect(context.counts.terminal).toBe(0);
    expect(context.defaultTab).toBe("preview");
  });

  it("exposes only capability-backed surfaces while retaining truthful activity and terminal empty states", () => {
    const runtime = summary();
    runtime.capabilities = [];
    runtime.previewSessions.items = [];
    const context = buildProjectInspectorContext({
      projectId: "matrix-os",
      summary: runtime,
      selectedThread: thread("thread_unbound", "matrix-os"),
      reviews: [review("rev_matrix", "matrix-os")],
    });

    expect(context.tabs).toEqual(["terminal", "activity"]);
    expect(context.reviews).toEqual([]);
    expect(context.terminalState).toBe("unbound");
    expect(context.defaultTab).toBe("activity");
  });
});
