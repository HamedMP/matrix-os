import { Button } from "@matrix-os/ui";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import type { InvokeRequest, InvokeResponse } from "../../../../shared/ipc-contract";
import { CHAT_ELECTRON_PREVIEW_MAX_AGE_MS, isCurrentChatElectronPreviewRun } from "../../../../shared/chat-electron-preview";
import { MATCHING_MAC_BUILD } from "../../../../shared/chat-electron-preview-ipc";
import { invoke } from "../../lib/operator";
import type { ComposerMentionAction } from "./ComposerMentionActions";
import { MAC_VERIFICATION_DEFAULT_TASK } from "./mac-verification-workflow";

type Status = InvokeResponse<"chat:electron-preview-run">["status"];
type RecipeSelection = NonNullable<InvokeRequest<"chat:electron-preview-run">["recipeSelection"]>;
type Worktree = Extract<NonNullable<CanonicalChatRun["executionRoot"]>, { kind: "worktree" }>;
type Candidate = { chatId: string; run: CanonicalChatRun; worktree: Worktree };
type Selection = { key: string };
type Attempt = { scope: string; runId: string; status: "pending" | "skipped" | Status; recipeSelection?: RecipeSelection };
type Intent = { scope: Selection; runId: string; recipeSelection?: RecipeSelection } & (
  { state: "draft" } | { state: "waiting"; previousRunId: string }
);
export type MacVerificationSubmission = { accept: (run: CanonicalChatRun) => void; finish: () => void };

export type MacVerificationDraft = {
  worktree: Worktree;
  checkCompatibility(): Promise<boolean | undefined>;
  beginSubmission: (draftKey: string, text: string, retry: boolean) => MacVerificationSubmission | "draft-changed" | undefined;
};

const RECIPE_OPTIONS = [["sign-in", "Sign-in"], ["files-trash", "Files Trash/Undo"]] as const;
const STATUS: Record<Attempt["status"], string> = {
  pending: "Mac verification pending…",
  skipped: "Mac verification skipped because the requested worktree run did not finish as expected.",
  returned: "Mac verification returned to this Chat.",
  declined: "Mac verification declined on this Mac.",
  unavailable: "Mac verification is unavailable for this worktree.",
  failed: "Mac verification failed.",
  busy: "This Mac is already handling a verification.",
  "already-handled": "This Mac verification was already handled.",
  incompatible: MATCHING_MAC_BUILD,
};

export function useMacVerification({ candidate, discoverable = false, available = true, busy, editingQueuedTurn, permissionMode, terminalRequests = false }: {
  discoverable?: boolean;
  available?: boolean;
  candidate: Candidate | null;
  busy: boolean;
  editingQueuedTurn: boolean;
  permissionMode?: string;
  terminalRequests?: boolean;
}) {
  const key = candidate
    ? JSON.stringify([candidate.chatId, candidate.worktree.projectId, candidate.worktree.worktreeId])
    : null;
  const selection = useRef<Selection | null>(null);
  const permissionSelection = useMemo(() => ({}), [permissionMode]);
  const currentPermissionSelection = useRef(permissionSelection);
  const fullAccess = useRef<{ viewId: string; ready: Promise<boolean> } | null>(null);
  const chatId = candidate?.chatId;
  const projectId = candidate?.worktree.projectId;
  const worktreeId = candidate?.worktree.worktreeId;
  const inFlight = useRef<Attempt | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const pendingIntent = useRef<Intent | null>(null);
  const submittingIntent = useRef<{ intent: Intent; draftKey: string } | null>(null);
  const latestRun = useRef<string | null>(null);
  const latestDraftRun = useRef<string | null>(null);
  const currentRunId = candidate?.run.id;
  const draftRunId = busy || editingQueuedTurn ? null : currentRunId ?? null;
  const lastTerminal = useRef<{ scope: Selection; runId: string; digest: string } | null>(null);
  useLayoutEffect(() => {
    selection.current = key ? { key } : null;
    setIntent(null);
    setAttempt(null);
    setSetupMessage(null);
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
    currentPermissionSelection.current = permissionSelection;
    if (!pendingIntent.current) return;
    pendingIntent.current = null;
    setIntent(null);
  }, [permissionSelection]);

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

  async function request(selectionInput: Pick<InvokeRequest<"chat:electron-preview-run">, "terminalIntentDigest" | "recipeSelection"> = {}) {
    const current = selection.current;
    if (!candidate || !current || current.key !== key || !canStart
      || latestRun.current !== candidate.run.id) return;
    if (inFlight.current) {
      setAttempt({ scope: current.key, runId: candidate.run.id, status: "busy" });
      return "busy" as const;
    }
    const pending: Attempt = { scope: current.key, runId: candidate.run.id, status: "pending", recipeSelection: selectionInput.recipeSelection };
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
        ...selectionInput,
      });
      if (selection.current === current) setAttempt({ ...pending, status: response.status });
      return response.status;
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
    void request(currentIntent.recipeSelection ? { recipeSelection: currentIntent.recipeSelection } : {});
  });
  const completedAt = candidate?.run.completedAt;
  const startTerminalVerification = useEffectEvent((requestedChat: string, requestedRun: string, digest: string) => {
    const current = selection.current;
    if (!candidate || !current || current.key !== key || !canStart || pendingIntent.current
      || inFlight.current || candidate.chatId !== requestedChat || candidate.run.id !== requestedRun
      || latestRun.current !== requestedRun) return;
    const prior = lastTerminal.current;
    if (prior?.scope === current && prior.runId === requestedRun && prior.digest === digest) return;
    const attempt = { scope: current, runId: requestedRun, digest };
    lastTerminal.current = attempt;
    // Busy and unknown outcomes stay deduplicated until an explicit owner retry.
    void request({ terminalIntentDigest: digest });
  });
  const terminalRetry = lastTerminal.current;
  const canRetryTerminal = Boolean(canStart && (status === "unavailable" || status === "busy")
    && terminalRetry?.scope === selection.current && terminalRetry?.scope.key === key
    && terminalRetry?.runId === candidate?.run.id);
  function retryTerminalVerification() {
    if (!canRetryTerminal || !terminalRetry || selection.current !== terminalRetry.scope
      || currentPermissionSelection.current !== permissionSelection || lastTerminal.current !== terminalRetry
      || latestRun.current !== terminalRetry.runId || pendingIntent.current || inFlight.current
      || !candidate || !isCurrentChatElectronPreviewRun(candidate.run)) return;
    // Only user input retries the exact digest. Native claims still fence execution.
    void request({ terminalIntentDigest: terminalRetry.digest });
  }

  // Poll only the eligible visible Chat and drop replies after navigation or a new run.
  useEffect(() => {
    if (!terminalRequests || !canStart || currentIntent || !chatId || !currentRunId || !completedAt) return;
    const expiresAt = Date.parse(completedAt) + CHAT_ELECTRON_PREVIEW_MAX_AGE_MS;
    let current = true;
    let reportedFailure = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check(chat: string, run: string) {
      if (!current || Date.now() >= expiresAt) return;
      try {
        const response = await invoke("chat:mac-verification-terminal-intent", { chatId: chat, runId: run });
        if (current && Date.now() < expiresAt && response.digest) startTerminalVerification(chat, run, response.digest);
      } catch (error: unknown) {
        if (!reportedFailure) {
          console.warn("[mac-verification] Terminal request check failed", error instanceof Error ? error.name : "UnknownError");
          reportedFailure = true;
        }
      }
      if (current && Date.now() < expiresAt) timer = setTimeout(() => void check(chat, run), 3_000);
    }
    void check(chatId, currentRunId);
    return () => { current = false; clearTimeout(timer); };
  }, [canStart, chatId, completedAt, currentIntent, currentRunId, key, terminalRequests]);
  useEffect(() => {
    completeIntent();
  }, [busy, canStart, currentIntent, currentRunId]);

  const draft: MacVerificationDraft | undefined = candidate && currentIntent?.state === "draft" ? {
    worktree: candidate.worktree,
    async checkCompatibility() {
      const { verificationAvailable } = await invoke("chat:electron-preview-available", {
        target: { chatId: candidate.chatId, runId: currentIntent.runId },
      });
      if (pendingIntent.current === currentIntent && selection.current === currentIntent.scope) return verificationAvailable === true;
    },
    beginSubmission: (draftKey, text, retry) => {
      if (pendingIntent.current !== currentIntent || selection.current !== currentIntent.scope) return;
      const previous = submittingIntent.current;
      if (previous && previous.draftKey !== draftKey) return "draft-changed";
      if (!previous && (retry || latestDraftRun.current !== currentIntent.runId)) return;
      const recipeSelection = currentIntent.recipeSelection ?? (text === MAC_VERIFICATION_DEFAULT_TASK ? undefined : "changed-only");
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
          stage({ ...currentIntent, runId: run.id, previousRunId: currentIntent.runId, state: "waiting", recipeSelection });
        },
      };
    },
  } : undefined;
  const action: ComposerMentionAction | undefined = discoverable && !busy && !editingQueuedTurn
    && status !== "pending" && !currentIntent ? {
    label: "Mac Verification",
    kind: "preview",
    keywords: "mac verification verify worktree test screenshot",
    consumeTrigger: true,
    defaultDraft: MAC_VERIFICATION_DEFAULT_TASK,
    slashCommand: "mac-verification",
    select: () => {
      if (!available) {
        setSetupMessage("Mac Verification is unavailable on this Computer. Sign in to your paired Mac in Matrix Electron Desktop and check Mac Pairing.");
        return;
      }
      const current = selection.current;
      if (!candidate || !current || current.key !== key || latestDraftRun.current !== candidate.run.id || pendingIntent.current) {
        setSetupMessage("Ask the agent to prepare an isolated worktree for this Chat first. Mac Verification will use that task's worktree automatically.");
        return;
      }
      setSetupMessage(null);
      stage({ scope: current, runId: candidate.run.id, state: "draft" });
    },
  } : undefined;
  const feedback = currentIntent || status || setupMessage ? (
    <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs text-[var(--text-secondary)]">
      <p role="status">{currentIntent
        ? currentIntent.state === "draft" ? "Mac verification will run after this message." : "Waiting for the worktree run…"
        : status === "unavailable" && attempt?.recipeSelection === "changed-only"
          ? "Mac verification is unavailable. For an unchanged worktree, choose Files Trash/Undo or Sign-in before sending."
          : status === "unavailable" && permissionMode === "full_access"
          ? "Mac verification is unavailable. Check Mac Pairing, or switch to Supervised to approve once."
          : status ? STATUS[status] : setupMessage}</p>
      {currentIntent?.state === "draft" && RECIPE_OPTIONS.map(([recipeSelection, label]) => (
        <Button key={recipeSelection} type="button" variant={currentIntent.recipeSelection === recipeSelection ? "secondary" : "ghost"} size="sm" aria-pressed={currentIntent.recipeSelection === recipeSelection}
          onClick={() => {
            if (pendingIntent.current !== currentIntent || submittingIntent.current) return;
            stage({ ...currentIntent, recipeSelection: currentIntent.recipeSelection === recipeSelection ? undefined : recipeSelection });
          }}>{label}</Button>
      ))}
      {currentIntent ? <button type="button" className="underline" onClick={() => stage(null)}>Cancel verification</button> : null}
      {canRetryTerminal ? <button type="button" className="underline" onClick={retryTerminalVerification}>Retry Mac verification</button> : null}
    </div>
  ) : null;
  return { action, feedback, draft };
}
