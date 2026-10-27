import { createCanonicalChatAdmissionTracker } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { AppError } from "../../../../shared/app-error";

export async function admitDesktopChatTurn(options: {
  client: CanonicalChatClient; tracker: ReturnType<typeof createCanonicalChatAdmissionTracker>;
  identity: unknown; scope: string; input: Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision"> & { clientRequestId?: string };
  title: string; projectId: string | null; detail: CanonicalChatDetailResponse | null;
  current: () => CanonicalChatDetailResponse | null;
  onSnapshot: (detail: CanonicalChatDetailResponse) => void;
  isCurrent: () => boolean; mayDispatch: () => boolean; onAccepted: () => void;
  onConfirmed: (requestId: string) => void; onPrepared: (requestId: string) => void;
  canAcknowledge: () => boolean; onRejected?: () => void;
}) {
  const { clientRequestId: seed, ...input } = options.input;
  const attempt = options.tracker.prepare(options.identity, options.scope, input, seed);
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
    onAccepted: options.onAccepted, onRejected: options.onRejected, onConfirmed: () => options.onConfirmed(attempt.id),
    definitive: error => error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408,
  });
}
