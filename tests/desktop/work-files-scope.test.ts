import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { resolveWorkFilesScope } from "@desktop/renderer/src/features/work/work-files-scope";
import type { Project } from "@desktop/renderer/src/stores/board";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { describe, expect, it } from "vitest";

const project: Project = {
  id: "project_stable",
  slug: "matrix-os",
  name: "Matrix OS",
  kind: "github",
};

function detail(options: {
  projectId?: string;
  roots?: Array<{ kind: "project"; projectId: string } | { kind: "worktree"; projectId: string; worktreeId: string } | undefined>;
  activeRunIndex?: number;
} = {}): CanonicalChatDetailResponse {
  const fixture = createCanonicalChatFixture("completed").snapshot;
  const roots = options.roots ?? [];
  const runs = roots.map((root, index) => ({
    ...fixture.runs[0]!,
    id: `run_scope_${index}`,
    ...(root ? { executionRoot: root, executionRootFingerprint: `${index}`.repeat(64) } : {
      executionRoot: undefined,
      executionRootFingerprint: undefined,
    }),
  }));
  return {
    record: {
      chat: {
        id: fixture.chat.id,
        ownerScope: fixture.chat.ownerScope,
        title: fixture.chat.title,
        lifecycle: fixture.chat.lifecycle,
        attention: fixture.chat.attention,
        revision: fixture.chat.revision,
        messageCount: fixture.chat.messageCount,
        createdAt: fixture.chat.createdAt,
        updatedAt: fixture.chat.updatedAt,
      },
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.activeRunIndex === undefined ? {} : {
        activeRun: {
          runId: runs[options.activeRunIndex]!.id,
          turnId: runs[options.activeRunIndex]!.turnId,
          status: "running",
        },
      }),
    },
    messages: [],
    turns: [],
    runs,
    activities: [],
  };
}

describe("resolveWorkFilesScope", () => {
  it("uses Matrix Home for a Global Chat regardless of run roots", () => {
    expect(resolveWorkFilesScope(detail({
      roots: [{ kind: "worktree", projectId: "foreign", worktreeId: "wt_foreign" }],
    }), [project])).toEqual({ kind: "home", chatId: "chat_fixture_completed" });
  });

  it("uses the matched owner Project slug for a Project Chat without a run root", () => {
    expect(resolveWorkFilesScope(detail({ projectId: "project_stable" }), [project])).toEqual({
      kind: "project",
      chatId: "chat_fixture_completed",
      projectId: "matrix-os",
      label: "Matrix OS",
    });
  });

  it("uses the active run worktree when the record names an active run", () => {
    expect(resolveWorkFilesScope(detail({
      projectId: "project_stable",
      roots: [
        { kind: "project", projectId: "project_stable" },
        { kind: "worktree", projectId: "project_stable", worktreeId: "wt_active" },
      ],
      activeRunIndex: 1,
    }), [project])).toMatchObject({ kind: "project", projectId: "matrix-os", worktreeId: "wt_active" });
  });

  it("uses the newest completed run worktree when no run is active", () => {
    expect(resolveWorkFilesScope(detail({
      projectId: "project_stable",
      roots: [
        { kind: "project", projectId: "project_stable" },
        { kind: "worktree", projectId: "project_stable", worktreeId: "wt_latest" },
      ],
    }), [project])).toMatchObject({ kind: "project", worktreeId: "wt_latest" });
  });

  it("does not resurrect an older worktree when the newest run has no root", () => {
    expect(resolveWorkFilesScope(detail({
      projectId: "project_stable",
      roots: [
        { kind: "worktree", projectId: "project_stable", worktreeId: "wt_old" },
        undefined,
      ],
    }), [project])).toEqual({
      kind: "project",
      chatId: "chat_fixture_completed",
      projectId: "matrix-os",
      label: "Matrix OS",
    });
  });

  it("fails closed when the projected active run is absent from the detail", () => {
    const input = detail({
      projectId: "project_stable",
      roots: [{ kind: "project", projectId: "project_stable" }],
    });
    input.record.activeRun = {
      runId: "run_missing",
      turnId: input.runs[0]!.turnId,
      status: "running",
    };

    expect(resolveWorkFilesScope(input, [project])).toEqual({
      kind: "unavailable",
      chatId: "chat_fixture_completed",
    });
  });

  it("uses the Project root when the projected active run exists without a root", () => {
    expect(resolveWorkFilesScope(detail({
      projectId: "project_stable",
      roots: [undefined],
      activeRunIndex: 0,
    }), [project])).toEqual({
      kind: "project",
      chatId: "chat_fixture_completed",
      projectId: "matrix-os",
      label: "Matrix OS",
    });
  });

  it("fails closed when the selected run root belongs to another Project", () => {
    expect(resolveWorkFilesScope(detail({
      projectId: "project_stable",
      roots: [{ kind: "worktree", projectId: "project_foreign", worktreeId: "wt_foreign" }],
    }), [project])).toEqual({ kind: "unavailable", chatId: "chat_fixture_completed" });
  });

  it("fails closed when the stable Project id is absent from the owner registry", () => {
    expect(resolveWorkFilesScope(detail({ projectId: "project_missing" }), [project])).toEqual({
      kind: "unavailable",
      chatId: "chat_fixture_completed",
    });
  });
});
