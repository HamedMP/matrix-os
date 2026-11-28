import React, { useEffect, useRef, useState } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { InvokeResponse } from "../../../../shared/ipc-contract";
import {
  CHAT_ELECTRON_PREVIEW_BASE_LABEL,
  CHAT_ELECTRON_PREVIEW_PREFIX,
  CHAT_ELECTRON_PREVIEW_SOURCE,
  getChatElectronPreviewMarkerForRun,
  isCurrentChatElectronPreviewRun,
} from "../../../../shared/chat-electron-preview";
import { invoke } from "../../lib/operator";
import type { ComposerMentionAction } from "./ComposerMentionActions";
import { useMacVerification } from "./ChatMacVerification";

type PreviewStatus = InvokeResponse<"chat:electron-preview-run">["status"];
const PREVIEW_STATUS: Record<PreviewStatus, string> = {
  returned: "Electron preview returned to this Chat.",
  declined: "Electron preview declined on this Mac.",
  unavailable: "Electron preview is currently unavailable on this Mac.",
  failed: "Electron preview could not be completed.",
  busy: "This Mac is already handling an Electron preview.",
  "already-handled": "This Electron preview request was already handled.",
};

const PREVIEW_DRAFT_INTRO = "Prepare an Electron preview of the Matrix OS sign-in page in this Chat's isolated worktree.";

const CHAT_ELECTRON_PREVIEW_DRAFT = [
  PREVIEW_DRAFT_INTRO,
  "Confirm the selected run is bound to an isolated Matrix OS worktree and tracked Git status is clean. Stop if either check fails.",
  `In ${CHAT_ELECTRON_PREVIEW_SOURCE}, replace the single ${CHAT_ELECTRON_PREVIEW_BASE_LABEL} literal with YOUR SPACE TO BUILD. Leave other source untouched.`,
  "Keep the change uncommitted. Run git diff --check and verify the full source matches git show HEAD:<path> with exactly that label replacement.",
  "Report the actual check results. Only if both checks pass, emit exactly one standalone unquoted line in this format, using the full actual HEAD and SHA-256 of the complete changed file:",
  `${CHAT_ELECTRON_PREVIEW_PREFIX}{"baseSha":"<40 lowercase hex>","sourceSha256":"<64 lowercase hex>","label":"YOUR SPACE TO BUILD","mainChecksPassed":true}`,
].join("\n\n");

export function isChatElectronPreviewDraft(text: string) {
  return text.startsWith(PREVIEW_DRAFT_INTRO)
    || text.split("\n").some(line => line.startsWith(CHAT_ELECTRON_PREVIEW_PREFIX));
}

export function backgroundElectronPreviewDraft(targetId: string) {
  return CHAT_ELECTRON_PREVIEW_DRAFT.replace(
    '"mainChecksPassed":true}',
    `"mainChecksPassed":true,"operation":"verify-sign-in-recovery","backgroundTargetId":${JSON.stringify(targetId)}}`,
  );
}

export function chatElectronPreviewWorktree(detail: CanonicalChatDetailResponse) {
  const latestRun = detail.runs.at(-1);
  const root = latestRun?.executionRoot;
  if (latestRun?.chatId !== detail.record.chat.id || root?.kind !== "worktree"
    || root.projectId !== detail.record.projectId) return null;
  return root;
}

type Worktree = NonNullable<ReturnType<typeof chatElectronPreviewWorktree>>;

export type StageChatWorktreeDraft = (
  text: string, worktree: Worktree, queryDraft: string, expiresAt?: number, backgroundTargetId?: string,
) => boolean;

interface ChatElectronPreviewProps {
  active: boolean;
  editingQueuedTurn?: boolean;
  actorId: string | null;
  detail: CanonicalChatDetailResponse;
  onDraft?: StageChatWorktreeDraft;
}

interface PreviewAttempt {
  key: string;
  promise: Promise<PreviewStatus>;
}

export function useChatElectronPreview({ active, editingQueuedTurn = false, actorId, detail, onDraft }: ChatElectronPreviewProps) {
  const { chat, activeRun, projectId } = detail.record;
  const eligible = active && !!projectId && chat.lifecycle === "active" && !chat.collaboration
    && chat.ownerScope.type === "personal" && chat.ownerScope.ownerId === actorId;
  const latestRun = detail.runs.at(-1);
  const worktree = chatElectronPreviewWorktree(detail);
  const marker = latestRun && getChatElectronPreviewMarkerForRun(detail, latestRun.id);
  const runId = eligible && !activeRun && worktree && latestRun && isCurrentChatElectronPreviewRun(latestRun)
    && marker && !marker.backgroundTargetId ? latestRun.id : null;
  const [available, setAvailable] = useState(false);
  const [verificationAvailable, setVerificationAvailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; status: PreviewStatus } | null>(null);
  const availability = useRef<Promise<InvokeResponse<"chat:electron-preview-available">> | null>(null);
  const attempt = useRef<PreviewAttempt | null>(null);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- Availability is a bounded capability read from the native process.
  useEffect(() => {
    if (!eligible || !window.operator?.invoke) return;
    let current = true;
    function readAvailability(): Promise<InvokeResponse<"chat:electron-preview-available">> {
      return invoke("chat:electron-preview-available", {}).catch((error: unknown) => {
        console.warn("[electron-preview] capability unavailable", error instanceof Error ? error.name : "UnknownError");
        return { available: false };
      });
    }
    function loadCapability(refresh?: boolean) {
      if (refresh || !availability.current) availability.current = readAvailability();
      const request = availability.current;
      void request.then(value => {
        if (current && availability.current === request) {
          setAvailable(value.available);
          setVerificationAvailable(value.verificationAvailable === true);
        }
      });
    }
    const refresh = () => loadCapability(true);
    loadCapability();
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [eligible]);

  const key = runId ? JSON.stringify([chat.id, runId, retry]) : null;
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- A committed request in the visible Chat delegates approval and execution to the native process.
  useEffect(() => {
    if (!available || !key || !runId) return;
    let current = true;
    if (attempt.current?.key !== key) {
      const promise = invoke("chat:electron-preview-run", { chatId: chat.id, runId })
        .then(response => response.status)
        .catch((error: unknown) => {
          console.warn("[electron-preview] request unavailable", error instanceof Error ? error.name : "UnknownError");
          return "unavailable" as const;
        });
      attempt.current = { key, promise };
    }
    void attempt.current.promise.then(status => { if (current) setResult({ key, status }); });
    return () => { current = false; };
  }, [available, chat.id, key, runId]);

  const canPreview = available && eligible && worktree !== null;
  const verification = useMacVerification({
    busy: Boolean(activeRun),
    editingQueuedTurn,
    candidate: verificationAvailable && eligible && worktree && latestRun?.driverKind === "codex"
      ? { chatId: chat.id, run: latestRun, worktree } : null,
  });
  const action: ComposerMentionAction | undefined = canPreview && !activeRun && onDraft ? {
    label: "Request Electron preview",
    kind: "preview",
    keywords: "mac",
    select: (queryDraft) => { onDraft(CHAT_ELECTRON_PREVIEW_DRAFT, worktree, queryDraft); },
  } : undefined;
  const status = result?.key === key ? result?.status : null;
  const feedback = canPreview && key ? (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[var(--text-secondary)]">
      <span role="status">{status ? PREVIEW_STATUS[status] : "Electron preview pending on this Mac…"}</span>
      {status === "busy" || status === "unavailable" ? (
        <button type="button" className="rounded px-2 py-1 font-medium hover:bg-[var(--bg-hover)]"
          onClick={() => setRetry(value => value + 1)}>Retry preview</button>
      ) : null}
    </div>
  ) : null;
  return { action, available: canPreview, feedback,
    verificationAction: verification.action, verificationFeedback: verification.feedback,
    verificationDraft: verification.draft };
}
