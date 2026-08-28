import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { buildWorkRailModel } from "@desktop/renderer/src/features/work/work-rail-model";
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

const projects: Project[] = [
  { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder" },
  { id: "project_beta_id", slug: "beta", name: "Beta", kind: "scratch" },
];

describe("buildWorkRailModel", () => {
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
});
