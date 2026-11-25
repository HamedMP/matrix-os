import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import {
  getLatestCompletedMacTerminalRun,
  getMacTerminalProbeMarkerForRun,
  isCurrentMacTerminalProbeRun,
  MAC_TERMINAL_PROBE_PREFIX,
} from "../../../../shared/mac-terminal-probe";
import type { InvokeResponse } from "../../../../shared/ipc-contract";
import { invoke } from "../../lib/operator";
import { chatElectronPreviewWorktree } from "./ChatElectronPreview";

type Preparation = InvokeResponse<"chat:mac-terminal-prepare">;
type RunStatus = InvokeResponse<"chat:mac-terminal-run">["status"];
type Worktree = NonNullable<ReturnType<typeof chatElectronPreviewWorktree>>;

const DRAFT_INTRO = "Request a read-only system check on the approved Mac terminal.";
const PREPARE_ERROR = {
  declined: "The Mac terminal check was declined.",
  unavailable: "The Mac terminal check is unavailable.",
  busy: "The Mac is already handling a terminal check.",
  failed: "The Mac terminal check could not be prepared.",
  expired: "The Mac terminal approval expired. Clear the draft and request a new check.",
  changed: "The Chat or worktree changed. Request a new Mac terminal check.",
};
const RUN_STATUS: Record<RunStatus, string> = {
  returned: "Mac terminal result returned to this Chat.",
  unavailable: "The Mac terminal approval is unavailable or expired.",
  busy: "The Mac is already handling a terminal check.",
  failed: "The Mac terminal check could not be completed.",
  "already-handled": "This Mac terminal check was already handled.",
};

function makeDraft(targetId: string): string {
  return [
    DRAFT_INTRO,
    "Do not run this command on Main or use a shell tool. Emit exactly this standalone unquoted line, without a code fence, and finish this turn so Matrix can deliver the Mac result to this Chat:",
    MAC_TERMINAL_PROBE_PREFIX + JSON.stringify({ targetId, action: "uname" }),
  ].join("\n\n");
}

export function isMacTerminalProbeDraft(text: string): boolean {
  return text.startsWith(DRAFT_INTRO) || text.split("\n").some(line => line.startsWith(MAC_TERMINAL_PROBE_PREFIX));
}

interface ChatMacTerminalProbeProps {
  active: boolean;
  actorId: string | null;
  detail: CanonicalChatDetailResponse;
  onDraft?: (text: string, worktree: Worktree, expiresAt: number) => boolean;
}

type PreparationState = Preparation | { status: "preparing" | "expired" | "changed" };

function preparationLabel(preparation: PreparationState | null, activeRun: boolean): string | undefined {
  if (!preparation) return;
  if (preparation.status === "preparing") return "Waiting for one-time approval on this Mac…";
  if (preparation.status === "ready") {
    const nextStep = activeRun ? "Waiting for the agent…" : "Send the draft to run it.";
    return `Mac terminal ${preparation.terminalId} approved for uname -s. ${nextStep}`;
  }
  return PREPARE_ERROR[preparation.status];
}

function logFailure(error: unknown) {
  console.warn("[mac-terminal-check] request unavailable", error instanceof Error ? error.name : "UnknownError");
}

export function ChatMacTerminalProbe({ active, actorId, detail, onDraft }: ChatMacTerminalProbeProps) {
  const { chat, activeRun, providerBinding } = detail.record;
  const root = chatElectronPreviewWorktree(detail);
  const readyToCheck = active && root !== null && !chat.collaboration && chat.lifecycle === "active"
    && chat.ownerScope.type === "personal" && chat.ownerScope.ownerId === actorId
    && providerBinding?.driverKind === "codex";
  const latestRun = getLatestCompletedMacTerminalRun(detail);
  const runId = readyToCheck && !activeRun && latestRun?.driverKind === "codex"
    && latestRun.executionRoot?.kind === "worktree" && latestRun.executionRoot.projectId === root.projectId
    && latestRun.executionRoot.worktreeId === root.worktreeId
    && isCurrentMacTerminalProbeRun(latestRun) && getMacTerminalProbeMarkerForRun(detail, latestRun.id)
    ? latestRun.id : null;
  const [available, setAvailable] = useState(false);
  const [preparation, setPreparation] = useState<PreparationState | null>(null);
  const [runResult, setRunResult] = useState<{ runId: string; status: RunStatus } | null>(null);
  const availability = useRef<Promise<boolean> | null>(null);
  const attempt = useRef<string | null>(null);
  const mounted = useRef(false);
  const stageDraft = useRef(onDraft);
  const preparing = useRef(false);

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

  const expiresAt = preparation?.status === "ready" ? preparation.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setPreparation({ status: "expired" }), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- A committed request delegates to main to verify and consume the native approval.
  useEffect(() => {
    if (!available || !runId || attempt.current === runId) return;
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
  }, [available, chat.id, runId]);

  async function prepare() {
    if (!root || !stageDraft.current || preparing.current) return;
    preparing.current = true;
    setPreparation({ status: "preparing" });
    try {
      const reply = await invoke("chat:mac-terminal-prepare", { chatId: chat.id, worktreeId: root.worktreeId });
      if (reply.status === "ready" && reply.expiresAt <= Date.now()) {
        setPreparation({ status: "expired" });
        return;
      }
      if (reply.status === "ready" && !stageDraft.current?.(makeDraft(reply.targetId), root, reply.expiresAt)) {
        await invoke("chat:mac-terminal-cancel", { chatId: chat.id });
        setPreparation({ status: "changed" });
        return;
      }
      setPreparation(reply);
    } catch (error: unknown) {
      logFailure(error);
      setPreparation({ status: "unavailable" });
    } finally {
      preparing.current = false;
    }
  }

  if (!available || !readyToCheck) return null;
  const preparationStatus = preparation?.status;
  const result = runResult && (!runId || runResult.runId === runId) ? runResult.status : null;
  const runLabel = result ? RUN_STATUS[result] : runId ? "Checking the approved Mac terminal…" : undefined;
  const status = preparationLabel(preparation, Boolean(activeRun)) ?? runLabel;
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[var(--text-secondary)]">
      {status ? <span role="status">{status}</span> : null}
      {onDraft && !activeRun && preparationStatus !== "preparing" && preparationStatus !== "ready" && (!runId || result) ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => { void prepare(); }}>
          Request Mac terminal check
        </Button>
      ) : null}
    </div>
  );
}
