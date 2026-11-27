import { createCanonicalChatAdmissionTracker, type CanonicalChatClientAdmission } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse, CanonicalChatTurnAdmissionResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { AppError } from "../../../../shared/app-error";

export async function admitDesktopChatTurn(options: {
  client: CanonicalChatClient; tracker: ReturnType<typeof createCanonicalChatAdmissionTracker>;
  identity: unknown; scope: string; input: Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision"> & { clientRequestId?: string };
  title: string; projectId: string | null; selectedChatId: string | null; detail: CanonicalChatDetailResponse | null;
  current: () => CanonicalChatDetailResponse | null;
  onSnapshot: (detail: CanonicalChatDetailResponse) => void;
  isCurrent: () => boolean; mayDispatch: () => boolean; onAccepted: () => void;
  onConfirmed: (requestId: string, receipt: CanonicalChatTurnAdmissionResponse) => void; onPrepared: (requestId: string) => void;
  canAcknowledge: () => boolean; onRejected?: () => void;
}) {
  const { clientRequestId: seed, ...input } = options.input;
  const attempt = options.tracker.prepare(options.identity, options.scope, input, seed,
    value => withChatContinuationRoot(value, options.detail, options.selectedChatId));
  options.onPrepared(attempt.id);
  const record = attempt.record ?? options.detail?.record ?? await options.client.create({
    clientRequestId: `${attempt.id}_chat`, title: options.title,
    ...(options.projectId === null ? {} : { projectId: options.projectId }), currentSelection: input.selection,
  });
  if (!options.mayDispatch()) return null;
  options.tracker.bind(attempt, record);
  return options.tracker.send(attempt, {
    post: request => options.client.admitTurn(record.chat.id, request, { chatScope: record.projectId ? "project" : "global" }),
    read: async () => { const detail = await options.client.getDetail(record.chat.id, { limit: 200 });
      if (options.isCurrent() && detail.record.chat.id === record.chat.id) options.onSnapshot(detail); return detail; }, current: options.current,
    isCurrent: options.isCurrent, canAcknowledge: options.canAcknowledge,
    onAccepted: options.onAccepted, onRejected: options.onRejected, onConfirmed: receipt => options.onConfirmed(attempt.id, receipt),
    definitive: error => error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408,
  });
}

function upsertAdmissionRow<T extends { id: string }>(rows: T[] = [], row: T): T[] {
  const index = rows.findIndex(existing => existing.id === row.id);
  if (index < 0) return [...rows, row];
  return rows.map((existing, position) => position === index ? row : existing);
}

export function resolveDesktopAdmittedDetail(
  admitted: CanonicalChatClientAdmission,
  captured: CanonicalChatDetailResponse | null,
  streamed: CanonicalChatDetailResponse | null,
): CanonicalChatDetailResponse {
  const chatId = admitted.record.chat.id;
  const previous = captured?.record.chat.id === chatId ? captured : null;
  const latest = streamed?.record.chat.id === chatId
    && streamed.record.chat.revision >= (previous?.record.chat.revision ?? -1) ? streamed : previous;
  const recovered = admitted.recoveredDetail;
  if (latest && latest.record.chat.revision >= (recovered?.record ?? admitted.record).chat.revision) return latest;
  if (recovered) return recovered;
  return {
    ...(latest ?? { activities: [] }),
    record: admitted.record,
    messages: upsertAdmissionRow(latest?.messages, admitted.message),
    turns: upsertAdmissionRow(latest?.turns, admitted.turn),
    runs: upsertAdmissionRow(latest?.runs, admitted.run),
  };
}

export function withChatContinuationRoot<T extends Pick<CanonicalCreateChatTurnRequest, "executionRoot">>(
  input: T,
  detail: CanonicalChatDetailResponse | null,
  selectedChatId: string | null,
): T {
  if (selectedChatId === null) return input;
  if (!detail || detail.record.chat.id !== selectedChatId) throw new AppError("server");
  const { record } = detail;
  // Shared and Bot Chats keep their existing admission rules.
  if (record.chat.ownerScope.type !== "personal" || record.chat.collaboration?.mode === "shared") return input;
  if (input.executionRoot) {
    if (input.executionRoot.kind === "worktree" && input.executionRoot.projectId !== record.projectId) {
      throw new AppError("server");
    }
    return input;
  }
  const active = record.activeRun;
  const run = active ? detail.runs.find(candidate => candidate.id === active.runId) : detail.runs.at(-1);
  if ((active && (!run || run.turnId !== active.turnId)) || (run && run.chatId !== selectedChatId)) {
    throw new AppError("server");
  }
  const root = run?.executionRoot;
  if (root?.kind !== "worktree") return input;
  if (root.projectId !== record.projectId) {
    if (active) throw new AppError("server");
    // An idle Chat can retain run history after a project move. Let the
    // gateway resolve an ordinary reply from the Chat's current assignment.
    return input;
  }
  // The gateway revalidates current ownership, existence and worktree availability.
  return { ...input, executionRoot: root };
}
