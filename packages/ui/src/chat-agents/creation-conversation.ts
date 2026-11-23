import {
  BotCreationSnapshotSchema, BotDraftProposalSchema,
  type BotCreationSnapshot, type BotDraftProposal,
  type CanonicalChatDetailResponse, type CanonicalChatModelSelection,
  type CanonicalChatRecord, type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatRequest, type CanonicalCreateChatTurnRequest,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { safeHttpStatus } from "./safe-http-status.js";

/** Adapt the existing authenticated surface client; never create a second transport. */
export interface CreationConversationClient {
  create(input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord>;
  detail(chatId: string): Promise<CanonicalChatDetailResponse>;
  admitTurn(chatId: string, input: CanonicalCreateChatTurnRequest): Promise<CanonicalChatTurnAdmissionResponse>;
  cancelRun(chatId: string, runId: string, clientRequestId: string): Promise<unknown>;
}
export type CreationConversationState = {
  detail: CanonicalChatDetailResponse | null;
  busy: boolean;
  error: string;
  activeRunId: string | null;
  accessLost?: boolean;
};
const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
const MAX_POLL_DURATION_MS = 10 * 60_000;

export function creationConversationSelection(catalog: CanonicalProviderCatalog | null): CanonicalChatModelSelection | null {
  const source = catalog?.instances.find(instance => instance.id === "matrix_pi_default");
  const selection = source?.defaultSelection;
  if (source?.availability !== "available" || source.driverKind !== "matrix_pi" || !selection
    || selection.instanceId !== source.id || selection.options?.length
    || !source.models.some(model => model.id === selection.model && model.availability === "available")
    || !source.supports.permissionModes.includes("supervised") || !source.supports.interactionModes.includes("default")) return null;
  return { ...selection };
}

/** Only real admission/readback produces transcript and proposal state. */
export function createCreationConversation(options: {
  client: CreationConversationClient;
  sessionId: string;
  isCurrent(): boolean;
  onProposal(proposal: BotDraftProposal): boolean;
  onChange(state: CreationConversationState): void;
}) {
  let current: CreationConversationState = { detail: null, busy: false, error: "", activeRunId: null };
  let chat: CanonicalChatRecord | null = null;
  const createRequestId = requestId();
  let attempt: { text: string; snapshot: BotCreationSnapshot; selection: CanonicalChatModelSelection; input: CanonicalCreateChatTurnRequest } | null = null;
  let admittedRunId: string | null = null;
  let deadline = 0;
  let refreshing = false;
  let disposed = false;
  const seenProposals: string[] = []; // At most 100 IDs; the active-run filter rejects historical runs.
  const live = () => !disposed && !current.accessLost && options.isCurrent();
  const update = (patch: Partial<CreationConversationState>) => {
    if (!live()) return;
    current = { ...current, ...patch };
    options.onChange(current);
  };
  function acceptRecord(record: CanonicalChatRecord) {
    if (record.chat.ownerScope.type === "personal" && !record.projectId && record.chat.collaboration?.mode !== "shared"
      && (!chat || chat.chat.id === record.chat.id && chat.chat.ownerScope.ownerId === record.chat.ownerScope.ownerId)) {
      chat = record;
      return true;
    }
    loseAccess();
    return false;
  }
  function loseAccess() {
    update({
      detail: null, busy: false, activeRunId: null, accessLost: true,
      error: "Private setup Chat is unavailable. Reopen the editor to start a new conversation."
    });
  }

  async function refresh(manual = false) {
    if (!live() || !chat || refreshing) return;
    if (!manual && deadline && Date.now() > deadline) {
      update({ busy: false, error: "Drafting is taking longer than expected. Check this Chat before sending another request." });
      return;
    }
    refreshing = true;
    try {
      const detail = await options.client.detail(chat.chat.id);
      if (!live()) return;
      if (!acceptRecord(detail.record)) return;
      for (const activity of detail.activities) {
        if (activity.type !== "bot.draft.proposed" || activity.runId !== admittedRunId) continue;
        const parsed = BotDraftProposalSchema.safeParse({
          proposalId: activity.proposalId, sessionId: activity.sessionId,
          baseDraftRevision: activity.baseDraftRevision, patch: activity.patch
        });
        if (!parsed.success || parsed.data.sessionId !== options.sessionId || seenProposals.includes(parsed.data.proposalId)) continue;
        seenProposals.push(parsed.data.proposalId);
        if (seenProposals.length > 100) seenProposals.shift();
        if (!options.onProposal(parsed.data)) update({ error: "Your configuration changed while Matrix AI was drafting. Keep your current changes and send another request." });
      }
      const run = detail.runs.find(value => value.id === admittedRunId);
      const terminal = run && ["completed", "failed", "aborted"].includes(run.status);
      update({
        detail, ...(terminal ? {
          busy: false, activeRunId: null,
          ...(run.status === "failed" ? { error: "Matrix AI could not finish this request. Your configuration is still here." } : {})
        } : {})
      });
    } catch (failure: unknown) {
      if (live()) {
        if ([401, 403, 404].includes(safeHttpStatus(failure) ?? 0)) {
          loseAccess();
          return;
        }
        console.warn("[bot-creation] Drafting Chat read failed:", failure instanceof Error ? failure.name : "UnknownError");
        update({ error: "Drafting Chat could not be refreshed. Your configuration is still here." });
      }
    } finally { refreshing = false; }
  }
  async function send(text: string, snapshotValue: BotCreationSnapshot, selection: CanonicalChatModelSelection): Promise<boolean> {
    if (!live() || current.busy || current.activeRunId || !text.trim() || text.length > 8_000 || snapshotValue.sessionId !== options.sessionId) return false;
    const checked = BotCreationSnapshotSchema.safeParse(snapshotValue);
    if (!checked.success) {
      update({ error: "Review your draft fields before asking Matrix AI to make changes." });
      return false;
    }
    const snapshot = checked.data;
    if (attempt && (attempt.text !== text || JSON.stringify(attempt.snapshot) !== JSON.stringify(snapshot)
      || JSON.stringify(attempt.selection) !== JSON.stringify(selection))) {
      update({ error: "The previous request could not be confirmed. Retry that same request before sending changed configuration." });
      return false;
    }
    update({ busy: true, error: "" });
    let accepted = false;
    try {
      if (!chat) {
        const created = await options.client.create({ clientRequestId: createRequestId, title: "Agent setup", currentSelection: selection });
        if (!live()) return false;
        if (!acceptRecord(created)) return false;
        chat = created;
      }
      if (!attempt) {
        const detail = await options.client.detail(chat.chat.id);
        if (!live()) return false;
        if (!acceptRecord(detail.record)) return false;
        update({ detail });
        attempt = {
          text, snapshot, selection, input: {
            clientRequestId: requestId(), baseRevision: chat.chat.revision,
            parts: [{ type: "text", text }], selection, interactionMode: "default", permissionMode: "supervised", botCreation: snapshot
          }
        };
      }
      const admitted = await options.client.admitTurn(chat.chat.id, attempt.input);
      if (!live()) return false;
      if (!acceptRecord(admitted.record)) return false;
      admittedRunId = admitted.run.id;
      attempt = null;
      deadline = Date.now() + MAX_POLL_DURATION_MS;
      accepted = true;
      update({ activeRunId: admitted.run.id });
      return true;
    } catch (failure: unknown) {
      if (live()) {
        console.warn("[bot-creation] Conversation admission failed:", failure instanceof Error ? failure.name : "UnknownError");
        update({ error: "Matrix AI could not accept this request. Your message and configuration are still here. Retry the same request." });
      }
      return false;
    } finally { if (!accepted) update({ busy: false }); }
  }
  async function abort() {
    if (!live() || !chat || !current.activeRunId) return;
    try {
      await options.client.cancelRun(chat.chat.id, current.activeRunId, requestId());
      if (live()) await refresh(true);
    } catch (failure: unknown) {
      if (live()) {
        console.warn("[bot-creation] Drafting cancellation failed:", failure instanceof Error ? failure.name : "UnknownError");
        update({ error: "Drafting could not be stopped. Check this Chat before sending another request." });
      }
    }
  }
  return { state: () => current, isCurrent: live, send, refresh, abort, activate: () => { disposed = false; }, dispose: () => { disposed = true; } };
}
