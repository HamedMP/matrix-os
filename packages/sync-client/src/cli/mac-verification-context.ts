import { z } from "zod/v4";
import {
  CanonicalChatDetailResponseSchema, CanonicalChatListResponseSchema, WorktreeIdSchema,
  type CanonicalChatDetailResponse,
} from "@matrix-os/contracts";

const Project = z.object({ project: z.object({ id: z.string().min(1).max(160), slug: z.literal("matrix-os") }) });
const Worktrees = z.object({ worktrees: z.array(z.object({ id: WorktreeIdSchema,
  projectSlug: z.literal("matrix-os"), path: z.string().min(1).max(4096) })).max(4096) });
type ErrorCode = "mac_verification_context_unavailable" | "mac_verification_response_invalid" | "mac_verification_worktree_unavailable";
interface Options {
  ownerId: string;
  root: string;
  read(path: string, query?: Record<string, string>): Promise<unknown>;
  fail(code: ErrorCode): never;
}
function live(detail: CanonicalChatDetailResponse, ownerId: string, projectId: string, worktreeId: string) {
  const { record, runs } = detail;
  const run = runs.at(-1);
  const start = Date.parse(run?.startedAt ?? "");
  return record.chat.lifecycle === "active" && record.chat.ownerScope.type === "personal"
    && record.chat.ownerScope.ownerId === ownerId && !record.chat.collaboration && record.projectId === projectId
    && record.activeRun?.status === "running" && run?.status === "running" && run.driverKind === "codex"
    && record.activeRun.runId === run.id && record.activeRun.turnId === run.turnId
    && run.executionRoot?.kind === "worktree" && run.executionRoot.projectId === projectId
    && run.executionRoot.worktreeId === worktreeId && run.capabilitySnapshot.attachments.includes("image")
    && run.capabilitySnapshot.permissionModes.includes("supervised") && run.capabilitySnapshot.interactionModes.includes("default")
    // An active task may legitimately run for hours. Its current admission
    // binds the intent; execution freshness starts when this exact run completes.
    && Number.isFinite(start) && start <= Date.now() ? run : null;
}

/** This is same-Computer discovery, not a cwd-name heuristic or a new grant.
 * An ambiguous/truncated inventory cannot authorize an inferred Chat. The native
 * receiver independently rereads this exact run after completion and pairs it. */
export async function resolveCurrentMacVerificationContext(options: Options) {
  const { read, fail, ownerId, root } = options;
  async function registeredTarget() {
    const project = Project.safeParse(await read("/api/projects/matrix-os"));
    const inventory = Worktrees.safeParse(await read("/api/projects/matrix-os/worktrees"));
    if (!project.success || !inventory.success) return fail("mac_verification_response_invalid");
    const matches = inventory.data.worktrees.filter(worktree => worktree.path === root);
    return matches.length === 1 ? { projectId: project.data.project.id, worktreeId: matches[0]!.id } : null;
  }
  const target = await registeredTarget();
  if (!target) return fail("mac_verification_worktree_unavailable");
  const { projectId, worktreeId } = target;
  const list = CanonicalChatListResponseSchema.safeParse(await read("/api/chats", { limit: "100", lifecycle: "active", projectId }));
  if (!list.success) return fail("mac_verification_response_invalid");
  // Fail closed instead of declaring uniqueness from only one page.
  if (list.data.nextCursor) return fail("mac_verification_context_unavailable");
  const candidates = list.data.items.filter(record => record.projectId === projectId
    && record.chat.lifecycle === "active" && record.chat.ownerScope.type === "personal"
    && record.chat.ownerScope.ownerId === ownerId && !record.chat.collaboration && record.activeRun?.status === "running");
  if (candidates.length > 20) return fail("mac_verification_context_unavailable");
  const bindings: { chatId: string; runId: string }[] = [];
  async function readDetail(chatId: string) {
    const detail = CanonicalChatDetailResponseSchema.safeParse(await read(`/api/chats/${encodeURIComponent(chatId)}`, { limit: "50" }));
    if (!detail.success || detail.data.record.chat.id !== chatId) return fail("mac_verification_response_invalid");
    return detail.data;
  }
  for (const record of candidates) {
    const run = live(await readDetail(record.chat.id), ownerId, projectId, worktreeId);
    if (run && record.activeRun?.runId === run.id) bindings.push({ chatId: record.chat.id, runId: run.id });
  }
  if (bindings.length !== 1) return fail("mac_verification_context_unavailable");
  const bound = bindings[0]!;
  return { ...bound, projectId, worktreeId,
    async recheck() {
      const current = await registeredTarget();
      if (current?.projectId !== projectId || current.worktreeId !== worktreeId) return fail("mac_verification_context_unavailable");
      const run = live(await readDetail(bound.chatId), ownerId, projectId, worktreeId);
      if (run?.id !== bound.runId) return fail("mac_verification_context_unavailable");
    },
  };
}
