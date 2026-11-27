import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import type { InvokeResponse } from "../../../../shared/ipc-contract";
import { isCurrentChatElectronPreviewRun } from "../../../../shared/chat-electron-preview";
import { invoke } from "../../lib/operator";
import type { ComposerMentionAction } from "./ComposerMentionActions";

type Status = InvokeResponse<"chat:electron-preview-run">["status"];
type Worktree = Extract<NonNullable<CanonicalChatRun["executionRoot"]>, { kind: "worktree" }>;
type Candidate = { chatId: string; run: CanonicalChatRun; worktree: Worktree };
type Selection = { key: string };
type Attempt = { scope: string; runId: string; status: "pending" | "skipped" | Status };
type Intent = { scope: Selection; runId: string } & (
  { state: "draft" } | { state: "waiting"; previousRunId: string }
);
export type MacVerificationSubmission = { accept: (run: CanonicalChatRun) => void; finish: () => void };

export type MacVerificationDraft = {
  worktree: Worktree;
  beginSubmission: (draftKey: string) => MacVerificationSubmission | "draft-changed" | undefined;
};

const STATUS: Record<Attempt["status"], string> = {
  pending: "Mac verification pending…",
  skipped: "Mac verification skipped because the requested worktree run did not finish as expected.",
  returned: "Mac verification returned to this Chat.",
  declined: "Mac verification declined on this Mac.",
  unavailable: "Mac verification is unavailable for this worktree.",
  failed: "Mac verification failed.",
  busy: "This Mac is already handling a verification.",
  "already-handled": "This Mac verification was already handled.",
};

export function useMacVerification({ candidate, busy, editingQueuedTurn, permissionMode }: {
  candidate: Candidate | null;
  busy: boolean;
  editingQueuedTurn: boolean;
  permissionMode?: string;
}) {
  const key = candidate
    ? JSON.stringify([candidate.chatId, candidate.worktree.projectId, candidate.worktree.worktreeId])
    : null;
  const selection = useRef<Selection | null>(null);
  const fullAccess = useRef<{ viewId: string; ready: Promise<boolean> } | null>(null);
  const chatId = candidate?.chatId;
  const projectId = candidate?.worktree.projectId;
  const worktreeId = candidate?.worktree.worktreeId;
  const inFlight = useRef<Attempt | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const pendingIntent = useRef<Intent | null>(null);
  const submittingIntent = useRef<{ intent: Intent; draftKey: string } | null>(null);
  const latestRun = useRef<string | null>(null);
  const latestDraftRun = useRef<string | null>(null);
  const currentRunId = candidate?.run.id;
  const draftRunId = busy || editingQueuedTurn ? null : currentRunId ?? null;
  useLayoutEffect(() => {
    selection.current = key ? { key } : null;
    setIntent(null);
    setAttempt(null);
    return () => {
      selection.current = null;
      pendingIntent.current = null;
      submittingIntent.current = null;
    };
  }, [key]);
  useLayoutEffect(() => {
    latestRun.current = currentRunId ?? null;
    latestDraftRun.current = draftRunId;
    const pending = pendingIntent.current;
    // Stream updates can arrive before the admission response for a submitted draft.
    if (pending?.state === "draft" && pending !== submittingIntent.current?.intent && pending.runId !== draftRunId) {
      pendingIntent.current = null;
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Revoke the stored choice and its stale callbacks before the composer can submit to the queue.
      setIntent(null);
    }
  }, [currentRunId, draftRunId]);

  useLayoutEffect(() => {
    if (!pendingIntent.current) return;
    pendingIntent.current = null;
    setIntent(null);
  }, [permissionMode]);

  useLayoutEffect(() => {
    if (permissionMode !== "full_access" || !chatId || !projectId || !worktreeId) return;
    const viewId = crypto.randomUUID();
    const warn = (error: unknown) => {
      console.warn("[mac-verification] selection update failed", error instanceof Error ? error.name : "UnknownError");
    };
    const ready = invoke("chat:mac-verification-selection", { viewId, scope: { chatId, projectId, worktreeId } })
      .then(success => success.accepted, error => { warn(error); return false; });
    fullAccess.current = { viewId, ready };
    return () => {
      fullAccess.current = null;
      void invoke("chat:mac-verification-selection", { viewId, scope: null }).catch(warn);
    };
  }, [chatId, permissionMode, projectId, worktreeId]);

  const status = attempt?.scope === key ? attempt?.status : undefined;
  const sameRun = attempt?.runId === candidate?.run.id;
  const canStart = Boolean(candidate && !busy && status !== "pending"
    && (!sameRun || !status || status === "busy" || status === "unavailable")
    && isCurrentChatElectronPreviewRun(candidate.run));
  const currentIntent = intent && intent.scope === selection.current && intent.scope.key === key ? intent : null;

  async function request() {
    const current = selection.current;
    if (!candidate || !current || current.key !== key || !canStart
      || latestRun.current !== candidate.run.id) return;
    if (inFlight.current) {
      setAttempt({ scope: current.key, runId: candidate.run.id, status: "busy" });
      return;
    }
    const pending: Attempt = { scope: current.key, runId: candidate.run.id, status: "pending" };
    inFlight.current = pending;
    setAttempt(pending);
    try {
      const binding = permissionMode === "full_access" ? fullAccess.current : null;
      if (permissionMode === "full_access" && (!binding || !await binding.ready || fullAccess.current !== binding
        || selection.current !== current || latestRun.current !== candidate.run.id)) {
        if (selection.current === current) setAttempt({ ...pending, status: "unavailable" });
        return;
      }
      const response = await invoke("chat:electron-preview-run", {
        chatId: candidate.chatId,
        runId: candidate.run.id,
        requestKind: "verification",
        ...(binding ? { fullAccessViewId: binding.viewId } : {}),
      });
      if (selection.current === current) setAttempt({ ...pending, status: response.status });
    } catch (error: unknown) {
      console.warn("[mac-verification] request failed", error instanceof Error ? error.name : "UnknownError");
      if (selection.current === current) setAttempt({ ...pending, status: "unavailable" });
    } finally {
      if (inFlight.current === pending) inFlight.current = null;
    }
  }

  function stage(next: Intent | null) {
    submittingIntent.current = null;
    pendingIntent.current = next;
    setIntent(next);
  }

  const completeIntent = useEffectEvent(() => {
    if (currentIntent?.state !== "waiting" || pendingIntent.current !== currentIntent || busy || !candidate
      || candidate.run.id === currentIntent.previousRunId
      || !["completed", "failed", "aborted"].includes(candidate.run.status)) return;
    stage(null);
    if (candidate.run.id !== currentIntent.runId || !canStart) {
      setAttempt({ scope: currentIntent.scope.key, runId: currentIntent.runId, status: "skipped" });
      return;
    }
    void request();
  });
  useEffect(() => {
    completeIntent();
  }, [busy, canStart, currentIntent, currentRunId]);

  const draft: MacVerificationDraft | undefined = candidate && currentIntent?.state === "draft" ? {
    worktree: candidate.worktree,
    beginSubmission: (draftKey) => {
      if (pendingIntent.current !== currentIntent || selection.current !== currentIntent.scope) return;
      const previous = submittingIntent.current;
      if (previous && previous.draftKey !== draftKey) return "draft-changed";
      if (!previous && latestDraftRun.current !== currentIntent.runId) return;
      const submission = previous ?? { intent: currentIntent, draftKey };
      submittingIntent.current = submission;
      return {
        finish: () => {
          if (submittingIntent.current !== submission) return;
          submittingIntent.current = null;
          if (pendingIntent.current === currentIntent && latestDraftRun.current !== currentIntent.runId) stage(null);
        },
        accept: (run) => {
          if (submittingIntent.current !== submission || pendingIntent.current !== currentIntent
            || selection.current !== currentIntent.scope) return;
          if (run.chatId !== candidate.chatId || run.id === currentIntent.runId || run.driverKind !== "codex"
            || run.executionRoot?.kind !== "worktree" || run.executionRoot.projectId !== candidate.worktree.projectId
            || run.executionRoot.worktreeId !== candidate.worktree.worktreeId) {
            stage(null);
            setAttempt({ scope: currentIntent.scope.key, runId: run.id, status: "skipped" });
            return;
          }
          stage({ scope: currentIntent.scope, runId: run.id, previousRunId: currentIntent.runId, state: "waiting" });
        },
      };
    },
  } : undefined;
  const action: ComposerMentionAction | undefined = candidate && canStart && !editingQueuedTurn && !currentIntent ? {
    label: "Mac Verification",
    kind: "preview",
    keywords: "mac verification verify worktree test screenshot",
    consumeTrigger: true,
    slashCommand: "mac-verification",
    select: (_query, remaining) => {
      const current = selection.current;
      if (!current || current.key !== key || latestDraftRun.current !== candidate.run.id || pendingIntent.current) return;
      if (remaining?.trim()) {
        stage({ scope: current, runId: candidate.run.id, state: "draft" });
        return;
      }
      void request();
    },
  } : undefined;
  const feedback = currentIntent || status ? (
    <div className="mb-2 flex items-center gap-2 px-1 text-xs text-[var(--text-secondary)]">
      <p role="status">{currentIntent
        ? currentIntent.state === "draft" ? "Mac verification will run after this message." : "Waiting for the worktree run…"
        : status === "unavailable" && permissionMode === "full_access"
          ? "Mac verification is unavailable. Check Mac Pairing, or switch to Supervised to approve once."
          : status ? STATUS[status] : null}</p>
      {currentIntent ? <button type="button" className="underline" onClick={() => stage(null)}>Cancel verification</button> : null}
    </div>
  ) : null;
  return { action, feedback, draft };
}
