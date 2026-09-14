import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import {
  buildWorkRailModel,
  buildWorkRailSearchResults,
  resolveWorkRailAgentState,
} from "@desktop/renderer/src/features/work/work-rail-model";
import type { Project } from "@desktop/renderer/src/stores/board";

function chat(
  id: string,
  title: string,
  options: { pinned?: boolean; projectId?: string; updatedAt: string },
): CanonicalChatRecord {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "owner_test" },
      title,
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      userState: {
        readThroughSeq: 0,
        pinned: options.pinned ?? false,
        muted: false,
      },
      createdAt: options.updatedAt,
      updatedAt: options.updatedAt,
    },
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
}

function statusRecord(options: {
  attention?: "none" | "approval_required" | "input_required" | "failed";
  activeRunStatus?: "accepted" | "running" | "waiting_for_approval" | "waiting_for_input";
  unacknowledged?: boolean;
}): CanonicalChatRecord {
  const record = chat("chat_status", "Status chat", {
    updatedAt: "2026-08-28T12:00:00.000Z",
  });
  return {
    ...record,
    chat: { ...record.chat, attention: options.attention ?? "none" },
    ...(options.activeRunStatus ? {
      activeRun: {
        runId: "run_status",
        turnId: "cturn_status",
        status: options.activeRunStatus,
      },
    } : {}),
    ...(options.unacknowledged === undefined ? {} : {
      latestSuccessfulCompletion: {
        runId: "run_completed_status",
        completedAt: "2026-08-28T12:01:00.000Z",
        unacknowledged: options.unacknowledged,
      },
    }),
  } as CanonicalChatRecord;
}

const projects: Project[] = [
  { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder" },
  { id: "project_beta_id", slug: "beta", name: "Beta", kind: "scratch" },
];

describe("buildWorkRailModel", () => {
  it("resolves rail state with attention ahead of running, failed, and unseen completion", () => {
    const cases: Array<[Parameters<typeof statusRecord>[0], string]> = [
      [{ attention: "approval_required", activeRunStatus: "running", unacknowledged: true }, "approval_required"],
      [{ attention: "input_required", activeRunStatus: "running", unacknowledged: true }, "input_required"],
      [{ activeRunStatus: "waiting_for_approval", unacknowledged: true }, "approval_required"],
      [{ activeRunStatus: "waiting_for_input", unacknowledged: true }, "input_required"],
      [{ activeRunStatus: "accepted", unacknowledged: true }, "running"],
      [{ attention: "failed", activeRunStatus: "running", unacknowledged: true }, "running"],
      [{ attention: "failed", unacknowledged: true }, "failed"],
      [{ unacknowledged: true }, "unseen_completion"],
      [{ unacknowledged: false }, "idle"],
      [{}, "idle"],
    ];
    expect(cases.map(([input]) => resolveWorkRailAgentState(statusRecord(input))))
      .toEqual(cases.map(([, expected]) => expected));
  });

  it("places every chat once across Pinned, Projects, and Recents", () => {
    const pinnedProject = chat("chat_pinned_project", "Pinned project", {
      pinned: true,
      projectId: "project_alpha_id",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    const model = buildWorkRailModel([
      pinnedProject,
      chat("chat_alpha", "Alpha chat", {
        projectId: "project_alpha_id",
        updatedAt: "2026-08-28T11:00:00.000Z",
      }),
      chat("chat_recent", "Recent global", { updatedAt: "2026-08-28T10:00:00.000Z" }),
      pinnedProject,
    ], projects);

    expect(model.pinned.map((record) => record.chat.id)).toEqual(["chat_pinned_project"]);
    expect(model.projects.map((project) => [
      project.id,
      project.slug,
      project.chats.map((record) => record.chat.id),
    ])).toEqual([
      ["project_alpha_id", "alpha", ["chat_alpha"]],
      ["project_beta_id", "beta", []],
    ]);
    expect(model.recents.map((record) => record.chat.id)).toEqual(["chat_recent"]);
  });

  it("maps both stable Project ids and slugs without changing API order", () => {
    const model = buildWorkRailModel([
      chat("chat_id_match", "ID match", {
        projectId: "project_alpha_id",
        updatedAt: "2026-08-28T09:00:00.000Z",
      }),
      chat("chat_slug_match", "Slug match", {
        projectId: "alpha",
        updatedAt: "2026-08-28T08:00:00.000Z",
      }),
      chat("chat_pinned_older", "Pinned older", {
        pinned: true,
        updatedAt: "2026-08-27T08:00:00.000Z",
      }),
      chat("chat_pinned_newer", "Pinned newer", {
        pinned: true,
        updatedAt: "2026-08-28T08:00:00.000Z",
      }),
      chat("chat_recent_older", "Recent older", {
        updatedAt: "2026-08-27T07:00:00.000Z",
      }),
      chat("chat_recent_newer", "Recent newer", {
        updatedAt: "2026-08-28T07:00:00.000Z",
      }),
    ], projects);

    expect(model.projects[0]?.chats.map((record) => record.chat.id)).toEqual([
      "chat_id_match",
      "chat_slug_match",
    ]);
    expect(model.pinned.map((record) => record.chat.id)).toEqual([
      "chat_pinned_older",
      "chat_pinned_newer",
    ]);
    expect(model.recents.map((record) => record.chat.id)).toEqual([
      "chat_recent_older",
      "chat_recent_newer",
    ]);
  });

  it("builds bounded canonical search results from safe title and context fields", () => {
    const global = chat("chat_global", "Deploy release", {
      updatedAt: "2026-08-28T11:00:00.000Z",
    });
    const project = chat("chat_project", "Deploy release", {
      projectId: "project_alpha_id",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    const providerBound = {
      ...project,
      chat: { ...project.chat, lastMessagePreview: "private-secret-needle" },
      providerBinding: {
        driverKind: "codex",
        instanceId: "provider_private_secret",
        lockedAtTurnId: "cturn_search",
      },
    } as CanonicalChatRecord;

    expect(buildWorkRailSearchResults([global, providerBound], projects, "deploy"))
      .toEqual([
        { record: providerBound, project: projects[0], contextLabel: "Alpha · Codex" },
        { record: global, contextLabel: "Global" },
      ]);
    expect(buildWorkRailSearchResults([global, providerBound], projects, "alpha"))
      .toEqual([{ record: providerBound, project: projects[0], contextLabel: "Alpha · Codex" }]);
    expect(buildWorkRailSearchResults([global, providerBound], projects, "codex"))
      .toHaveLength(1);
    expect(buildWorkRailSearchResults([global, providerBound], projects, "private-secret"))
      .toEqual([]);
    const unresolvedProject = chat("chat_missing_project", "Deploy missing", {
      projectId: "project_missing",
      updatedAt: "2026-08-28T12:30:00.000Z",
    });
    expect(buildWorkRailSearchResults([unresolvedProject], projects, "deploy"))
      .toEqual([]);
    const olderProjectDuplicate = {
      ...providerBound,
      chat: {
        ...providerBound.chat,
        id: "chat_project_duplicate",
        updatedAt: "2026-08-28T10:30:00.000Z",
      },
    } as CanonicalChatRecord;
    expect(buildWorkRailSearchResults(
      [providerBound, olderProjectDuplicate],
      projects,
      "deploy",
    ).map((result) => result.contextLabel)).toEqual([
      "Alpha · Codex · 2026-08-28 12:00:00 UTC",
      "Alpha · Codex · 2026-08-28 10:30:00 UTC",
    ]);
    const sameMinuteDuplicate = {
      ...providerBound,
      chat: {
        ...providerBound.chat,
        id: "chat_project_same_minute",
        updatedAt: "2026-08-28T12:00:59.000Z",
      },
    } as CanonicalChatRecord;
    expect(buildWorkRailSearchResults(
      [providerBound, sameMinuteDuplicate],
      projects,
      "deploy",
    ).map((result) => result.contextLabel)).toEqual([
      "Alpha · Codex · 2026-08-28 12:00:59 UTC",
      "Alpha · Codex · 2026-08-28 12:00:00 UTC",
    ]);
    const sameTimestampDuplicate = {
      ...providerBound,
      chat: {
        ...providerBound.chat,
        id: "chat_project_same_timestamp",
      },
    } as CanonicalChatRecord;
    expect(buildWorkRailSearchResults(
      [providerBound, sameTimestampDuplicate],
      projects,
      "deploy",
    ).map((result) => result.contextLabel)).toEqual([
      "Alpha · Codex · 2026-08-28 12:00:00 UTC · 1",
      "Alpha · Codex · 2026-08-28 12:00:00 UTC · 2",
    ]);
    expect(buildWorkRailSearchResults(
      Array.from({ length: 75 }, (_, index) => chat(`chat_${index}`, `Chat ${index}`, {
        updatedAt: new Date(Date.UTC(2026, 7, 28, 0, index)).toISOString(),
      })),
      projects,
      "",
    )).toHaveLength(50);
  });
});
