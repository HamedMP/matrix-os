import { describe, expect, it } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { withChatContinuationRoot } from "@desktop/renderer/src/features/chat/canonical-chat-continuation-root";
import { AppError } from "@desktop/shared/app-error";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const worktree = { kind: "worktree", projectId: "matrix-os", worktreeId: "wt_00000000000a" } as const;
const input: Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision"> = {
  parts: [{ type: "text", text: "Continue here." }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
  interactionMode: "default", permissionMode: "full_access",
};
function context(state: "running" | "completed" = "completed"): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture(state);
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  return { record: { chat, projectId: project.projectId, providerBinding, ...(activeRun ? { activeRun } : {}) },
    messages: snapshot.messages, turns: snapshot.turns,
    runs: snapshot.runs.map(run => ({ ...run, executionRoot: worktree })), activities: [] };
}

describe("canonical Chat continuation scope", () => {
  it("preserves an explicit project/skill selection over the inherited worktree", () => {
    const detail = context();
    const explicit = { ...input, executionRoot: { kind: "project", projectId: "matrix-os" } as const };
    expect(withChatContinuationRoot(explicit, detail, detail.record.chat.id)).toBe(explicit);
  });

  it("uses the active run's binding rather than a different historical run", () => {
    const detail = context("running");
    detail.runs.push({ ...detail.runs[0]!, id: "run_history", executionRoot: { kind: "project", projectId: "matrix-os" } });
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toEqual({ ...input, executionRoot: worktree });
    expect(input).not.toHaveProperty("executionRoot");
  });

  it.each(["missing active run", "foreign active turn", "foreign Chat", "changed project", "removed project"])("refuses %s without a project-root fallback", invalid => {
    const detail = context("running");
    if (invalid === "missing active run") detail.runs = [];
    if (invalid === "foreign active turn") detail.runs[0]!.turnId = "turn_foreign";
    if (invalid === "foreign Chat") detail.runs[0]!.chatId = "chat_foreign";
    if (invalid === "changed project") detail.record.projectId = "project_foreign";
    if (invalid === "removed project") delete detail.record.projectId;
    expect(() => withChatContinuationRoot(input, detail, detail.record.chat.id)).toThrow(AppError);
  });

  it("rejects missing or different selected-Chat detail, including explicit roots", () => {
    const detail = context();
    expect(() => withChatContinuationRoot(input, null, detail.record.chat.id)).toThrow(AppError);
    expect(() => withChatContinuationRoot({ ...input, executionRoot: worktree }, detail, "chat_other")).toThrow(AppError);
  });

  it("leaves new, legacy and shared Chats on their existing admission path", () => {
    const detail = context();
    expect(withChatContinuationRoot(input, detail, null)).toBe(input);
    delete detail.runs[0]!.executionRoot;
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
    detail.runs[0]!.executionRoot = worktree;
    detail.record.chat.ownerScope = { type: "organization", ownerId: "org_shared" };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
  });

  it("continues an explicitly private Chat without inheriting shared or Bot workspace policy", () => {
    const detail = context();
    detail.record.chat.collaboration = { mode: "private" };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toEqual({ ...input, executionRoot: worktree });
    detail.record.chat.collaboration = { mode: "shared", membership: { role: "owner", memberCount: 2 } };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
    delete detail.record.chat.collaboration;
    detail.runs[0]!.executionRoot = { kind: "bot_workspace", botId: "bot_00000000" };
    expect(withChatContinuationRoot(input, detail, detail.record.chat.id)).toBe(input);
  });
});
