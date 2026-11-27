import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import {
  getLatestCompletedMacTerminalRun,
  getMacTerminalProbeMarkerForRun,
  isCurrentMacTerminalProbeRun,
  MAC_TERMINAL_SYSTEM_CHECKS,
  MAC_TERMINAL_PROBE_PREFIX,
  type MacTerminalProbeAction,
} from "../../../../shared/mac-terminal-probe";
import type { InvokeResponse } from "../../../../shared/ipc-contract";
import { invoke } from "../../lib/operator";
import { backgroundElectronPreviewDraft, chatElectronPreviewWorktree, type StageChatWorktreeDraft } from "./ChatElectronPreview";
import type { ComposerMentionAction } from "./ComposerMentionActions";

type Preparation = InvokeResponse<"chat:mac-terminal-prepare">;
type RunStatus = InvokeResponse<"chat:mac-terminal-run">["status"];
type BackgroundStatus = InvokeResponse<"chat:mac-terminal-background-status">;
type ActiveBackground = Extract<BackgroundStatus, { active: true }>;

const DRAFT_INTRO = "Request a read-only system check on the approved Mac terminal.";
const PREPARE_ERROR = {
  declined: "The Mac terminal check was declined.",
  unavailable: "The Mac terminal check is unavailable.",
  busy: "The Mac is already handling a terminal check.",
  failed: "The Mac terminal check could not be prepared.",
  expired: "The Mac terminal approval expired. Clear the draft and request a new check.",
  changed: "The Chat or worktree changed. Request a new Mac terminal check.",
  "stop-failed": "Background Mac checks could not be stopped. Try again.",
};
const RUN_STATUS: Record<RunStatus, string> = {
  returned: "Mac terminal result returned to this Chat.",
  unavailable: "The Mac terminal approval is unavailable or expired.",
  busy: "The Mac is already handling a terminal check.",
  failed: "The Mac terminal check could not be completed.",
  "already-handled": "This Mac terminal check was already handled.",
};
const BACKGROUND_STATUS_POLL_MS = 2_000;

function makeDraft(targetId: string, mode: PreparationMode): string {
  const action: MacTerminalProbeAction = mode === "background" ? "system-checks" : "uname";
  return [
    DRAFT_INTRO,
    ...(action === "system-checks" ? [`Check the kernel, architecture, and macOS version using ${MAC_TERMINAL_SYSTEM_CHECKS.join(", ")}.`] : []),
    "Do not run these checks on Main or use a shell tool. Emit the line below exactly as written. Keep it outside any quotes or code fence. Finish the turn so Matrix can deliver the Mac result to this Chat.",
    MAC_TERMINAL_PROBE_PREFIX + JSON.stringify({ targetId, action }),
  ].join("\n\n");
}

export function isMacTerminalProbeDraft(text: string): boolean {
  return text.startsWith(DRAFT_INTRO) || text.split("\n").some(line => line.startsWith(MAC_TERMINAL_PROBE_PREFIX));
}

export async function canSendBackgroundMacCheck(chatId: string, worktreeId: string, targetId: string): Promise<boolean> {
  try {
    const grant = await invoke("chat:mac-terminal-background-status", { chatId, worktreeId });
    return grant.active && grant.targetId === targetId && grant.expiresAt > Date.now()
      && grant.remaining > 0 && grant.phase === "waiting";
  } catch (error: unknown) {
    logFailure(error);
    return false;
  }
}

interface ChatMacTerminalProbeProps {
  active: boolean;
  actorId: string | null;
  detail: CanonicalChatDetailResponse;
  onDraft?: StageChatWorktreeDraft;
  onDiscardDraft?: (text: string) => void;
  previewAvailable?: boolean;
}

type PreparationMode = "one-time" | "background";
type PreparationState = Preparation | { status: "preparing"; mode: PreparationMode }
  | { status: "expired" | "changed" | "stopping" | "stop-failed" };

function preparationLabel(preparation: PreparationState | null, activeRun: boolean): string | undefined {
  if (!preparation) return;
  if (preparation.status === "preparing") return preparation.mode === "background"
    ? "Waiting for background approval on this Mac…" : "Waiting for one-time approval on this Mac…";
  if (preparation.status === "stopping") return "Stopping background Mac checks…";
  if (preparation.status === "ready") {
    const nextStep = activeRun ? "Waiting for the agent…" : "Send the draft to run it.";
    return `Mac terminal ${preparation.terminalId} approved for uname -s. ${nextStep}`;
  }
  return PREPARE_ERROR[preparation.status];
}

function backgroundLabel(grant: ActiveBackground): string {
  if (grant.phase === "running") return "Running the approved Mac check…";
  if (grant.phase === "returning") return "Returning the Mac check result to this Chat…";
  const units = grant.remaining === 1 ? "check" : "checks";
  return `Background Mac checks approved. ${grant.remaining} ${units} left.`;
}

function logFailure(error: unknown) {
  console.warn("[mac-terminal-check] request unavailable", error instanceof Error ? error.name : "UnknownError");
}

export function useChatMacTerminalProbe({ active, actorId, detail, onDraft, onDiscardDraft, previewAvailable }: ChatMacTerminalProbeProps) {
  const { chat, activeRun, providerBinding } = detail.record;
  const root = chatElectronPreviewWorktree(detail);
  const readyToCheck = active && root !== null && !chat.collaboration && chat.lifecycle === "active"
    && chat.ownerScope.type === "personal" && chat.ownerScope.ownerId === actorId
    && providerBinding?.driverKind === "codex";
  const latestRun = getLatestCompletedMacTerminalRun(detail);
  const terminalMarker = latestRun && getMacTerminalProbeMarkerForRun(detail, latestRun.id);
  const runId = readyToCheck && !activeRun && latestRun?.driverKind === "codex"
    && latestRun.executionRoot?.kind === "worktree" && latestRun.executionRoot.projectId === root.projectId
    && latestRun.executionRoot.worktreeId === root.worktreeId
    && isCurrentMacTerminalProbeRun(latestRun) && terminalMarker?.action === "uname"
    ? latestRun.id : null;
  const [available, setAvailable] = useState(false);
  const [preparation, setPreparation] = useState<PreparationState | null>(null);
  const [runResult, setRunResult] = useState<{ runId: string; status: RunStatus } | null>(null);
  const [background, setBackground] = useState<{ scope: string; status: BackgroundStatus } | null>(null);
  const availability = useRef<Promise<boolean> | null>(null);
  const attempt = useRef<string | null>(null);
  const mounted = useRef(false);
  const stageDraft = useRef(onDraft);
  const changingGrant = useRef(false);
  const backgroundRevision = useRef(0);
  const previousBackground = useRef<{ scope: string; targetId: string } | null>(null);
  const worktreeId = root?.worktreeId;
  const scope = JSON.stringify([chat.id, worktreeId]);
  const backgroundStatus = background?.scope === scope ? background.status : null;
  const activeBackground = backgroundStatus?.active ? backgroundStatus : null;
  const backgroundTarget = activeBackground?.targetId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useLayoutEffect(() => {
    stageDraft.current = readyToCheck && !activeRun ? onDraft : undefined;
    return () => { stageDraft.current = undefined; };
  }, [activeRun, onDraft, readyToCheck]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- Reads the native developer-only capability.
  useEffect(() => {
    if (!readyToCheck || !window.operator?.invoke) return;
    let current = true;
    availability.current ??= invoke("chat:mac-terminal-available", {}).then(reply => reply.available).catch((error: unknown) => {
      logFailure(error);
      return false;
    });
    void availability.current.then(value => { if (current) setAvailable(value); });
    return () => { current = false; };
  }, [readyToCheck]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- An IPC read keeps the visible Chat in sync with the native grant.
  useEffect(() => {
    if (!available || !readyToCheck || !worktreeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const revision = backgroundRevision.current;
      if (!changingGrant.current) {
        try {
          const status = await invoke("chat:mac-terminal-background-status", { chatId: chat.id, worktreeId });
          if (!stopped && revision === backgroundRevision.current) setBackground({ scope, status });
        } catch (error: unknown) {
          if (!stopped) logFailure(error);
        }
      }
      if (!stopped) timer = setTimeout(() => { void refresh(); }, BACKGROUND_STATUS_POLL_MS);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [available, chat.id, readyToCheck, scope, worktreeId]);

  useEffect(() => {
    const previous = previousBackground.current;
    if (backgroundStatus && previous?.scope === scope && previous.targetId !== backgroundTarget) {
      onDiscardDraft?.(makeDraft(previous.targetId, "background"));
      onDiscardDraft?.(backgroundElectronPreviewDraft(previous.targetId));
    }
    previousBackground.current = backgroundTarget ? { scope, targetId: backgroundTarget } : null;
  }, [backgroundStatus, backgroundTarget, onDiscardDraft, scope]);

  const expiresAt = preparation?.status === "ready" ? preparation.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setPreparation({ status: "expired" }), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- A committed request delegates to main to verify and consume the native approval.
  useEffect(() => {
    if (!available || backgroundStatus?.active !== false || changingGrant.current || !runId || attempt.current === runId) return;
    attempt.current = runId;
    void invoke("chat:mac-terminal-run", { chatId: chat.id, runId })
      .then(reply => reply.status)
      .catch((error: unknown) => {
        logFailure(error);
        return "unavailable" as const;
      })
      .then(status => {
        if (!mounted.current || attempt.current !== runId) return;
        setRunResult({ runId, status });
        setPreparation(null);
      });
  }, [available, backgroundStatus?.active, chat.id, runId]);

  async function prepare(mode: PreparationMode, queryDraft: string) {
    const stage = stageDraft.current;
    if (!root || !stage || changingGrant.current) return;
    changingGrant.current = true;
    backgroundRevision.current++;
    setPreparation({ status: "preparing", mode });
    try {
      const request = { chatId: chat.id, worktreeId: root.worktreeId };
      const reply = mode === "background"
        ? await invoke("chat:mac-terminal-background-start", request)
        : await invoke("chat:mac-terminal-prepare", request);
      if (reply.status !== "ready") {
        setPreparation(reply);
        return;
      }
      if (reply.expiresAt <= Date.now()) {
        setPreparation({ status: "expired" });
        return;
      }
      const draft = makeDraft(reply.targetId, mode);
      const staged = stageDraft.current && stage(
        draft, root, queryDraft, reply.expiresAt, "terminalId" in reply ? undefined : reply.targetId,
      );
      if (!staged) {
        await invoke("chat:mac-terminal-cancel", { chatId: chat.id });
        setPreparation({ status: "changed" });
        return;
      }
      if ("terminalId" in reply) {
        setPreparation(reply);
      } else {
        const { targetId, expiresAt, remaining } = reply;
        setBackground({ scope, status: { active: true, targetId, expiresAt, remaining, phase: "waiting" } });
        setPreparation(null);
      }
    } catch (error: unknown) {
      logFailure(error);
      setPreparation({ status: "unavailable" });
    } finally {
      changingGrant.current = false;
    }
  }

  function stageAnother(kind: "terminal" | "preview", queryDraft: string) {
    if (!root || !activeBackground || activeBackground.expiresAt <= Date.now() || changingGrant.current) return;
    const { targetId, expiresAt } = activeBackground;
    const draft = kind === "preview" ? backgroundElectronPreviewDraft(targetId) : makeDraft(targetId, "background");
    stageDraft.current?.(draft, root, queryDraft, expiresAt, targetId);
  }

  async function stopBackground() {
    if (!activeBackground || changingGrant.current) return;
    changingGrant.current = true;
    backgroundRevision.current++;
    setPreparation({ status: "stopping" });
    try {
      await invoke("chat:mac-terminal-cancel", { chatId: chat.id });
      setBackground({ scope, status: { active: false } });
      setPreparation(null);
    } catch (error: unknown) {
      logFailure(error);
      setPreparation({ status: "stop-failed" });
    } finally {
      changingGrant.current = false;
    }
  }

  const actions: ComposerMentionAction[] = [];
  if (!available || !readyToCheck) return { actions, feedback: null };
  const preparationStatus = preparation?.status;
  const result = runResult && (!runId || runResult.runId === runId) ? runResult.status : null;
  const runLabel = result ? RUN_STATUS[result] : runId ? "Checking the approved Mac terminal…" : undefined;
  const status = preparationLabel(preparation, Boolean(activeRun))
    ?? (activeBackground ? backgroundLabel(activeBackground) : runLabel);
  const canPrepare = onDraft && !activeRun && backgroundStatus?.active === false
    && preparationStatus !== "preparing" && preparationStatus !== "ready" && preparationStatus !== "stopping"
    && (!runId || result);
  if (canPrepare) {
    actions.push(
      { label: "Request Mac terminal check", kind: "terminal", keywords: "system",
        select: (queryDraft) => { void prepare("one-time", queryDraft); } },
      { label: "Allow background Mac checks", kind: "terminal", keywords: "terminal system",
        select: (queryDraft) => { void prepare("background", queryDraft); } },
    );
  }
  if (onDraft && !activeRun && activeBackground?.phase === "waiting" && activeBackground.remaining > 0
    && preparationStatus !== "stopping") {
    actions.push({ label: "Draft another Mac check", kind: "terminal", keywords: "background terminal system",
      select: (queryDraft) => stageAnother("terminal", queryDraft) });
    if (previewAvailable) actions.push({
      label: "Draft background Electron preview", kind: "preview", keywords: "mac",
      select: (queryDraft) => stageAnother("preview", queryDraft),
    });
  }
  const feedback = status || activeBackground ? (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[var(--text-secondary)]">
      {status ? <span role="status">{status}</span> : null}
      {activeBackground ? (
        <Button type="button" size="sm" variant="ghost" disabled={preparationStatus === "stopping"}
          onClick={() => { void stopBackground(); }}>
          Stop background Mac checks
        </Button>
      ) : null}
    </div>
  ) : null;
  return { actions, feedback };
}
