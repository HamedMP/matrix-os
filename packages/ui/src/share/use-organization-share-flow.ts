import { useEffect, useRef, useState } from "react";
import type { CollaborativeAppShare } from "@matrix-os/contracts";
import type { CollaborativeHandoff } from "./use-collaborative-handoff";

/** The subset of `useCollaborativeAppSharing` the flow drives (spec 2689 readiness = single source of truth). */
export interface OrganizationSharing {
  share: CollaborativeAppShare | null;
  shareKnown: boolean;
  state: "idle" | "loading" | "checking" | "blocked" | "ready" | "stale" | "failed";
  actionState: "idle" | "loading" | "sharing" | "stopping" | "failed";
  actionMessage: string | null;
  recheck(input: { organizationId: string }): Promise<void>;
  createShare(input: { organizationId: string }, options?: { shouldContinue?: () => boolean }): Promise<CollaborativeAppShare | null>;
  stopShare(): Promise<CollaborativeAppShare | null>;
  refreshShare(): Promise<unknown>;
}

export type OrganizationShareStep = "idle" | "checking" | "required" | "running" | "applying" | "done";

interface Pending { organizationId: string; reason: "owner" | "completion" }

const NOT_READY_AFTER_CHAT = "Claude finished, but the app isn’t ready to share yet. Open the chat to keep going.";
const CHECK_FAILED = "Couldn’t check this app right now. Try again.";

/**
 * Org sharing with the collaborative gate. A share is created only after a
 * fresh readiness result of `ready` for the chosen organization; the server
 * preflight enforces the same rule. A builder-skill completion event only
 * triggers that recheck.
 */
// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- one bounded org-share state machine (owner share, completion event, readiness settle); splitting it would duplicate the readiness-gating invariant.
export function useOrganizationShareFlow({ sharing, handoff, onStartChat }: {
  sharing: OrganizationSharing;
  handoff: CollaborativeHandoff;
  onStartChat: (request: { organizationId: string; requestId: string }) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [required, setRequired] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const creating = useRef(false);
  const handledCompletion = useRef<string | null>(null);
  const shareRetried = useRef<string | null>(null);
  /** Bumped by every new attempt and by Cancel, so a cancelled attempt can never share. */
  const attempt = useRef(0);
  const shared = sharing.share?.state === "active" || sharing.share?.state === "needs_recheck";
  const record = handoff.record;

  // Completion event: the skill wrote completed/failed for the active request.
  // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- reacts to an external file record written by the builder skill, then starts a server recheck.
  useEffect(() => {
    if (!record || handledCompletion.current === record.requestId) return;
    if (record.state === "failed") {
      handledCompletion.current = record.requestId;
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- the skill reported failure through the external handoff record.
      setRequired(true); setNotice(NOT_READY_AFTER_CHAT);
      return;
    }
    if (record.state !== "completed" || shared) return;
    if (!sharing.shareKnown) {
      // A failed share read must not leave a finished setup stuck: retry it once per request.
      if (shareRetried.current !== record.requestId && sharing.actionState !== "loading") {
        shareRetried.current = record.requestId;
        void sharing.refreshShare();
      }
      return;
    }
    handledCompletion.current = record.requestId;
    // The share changed after this completion (for example the owner stopped it): never re-share.
    if (sharing.share && Date.parse(sharing.share.updatedAt) >= Date.parse(record.updatedAt)) return;
    attempt.current += 1;
    setPending({ organizationId: record.organizationId, reason: "completion" });
    void sharing.recheck({ organizationId: record.organizationId });
  }, [record, shared, sharing]);

  // Apply a share only when the recheck we asked for settles as ready.
  // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- synchronizes with the async readiness hook; the share must follow its server result.
  useEffect(() => {
    if (!pending || sharing.state === "checking" || sharing.state === "loading" || creating.current) return;
    if (sharing.state === "ready") {
      creating.current = true;
      const mine = attempt.current;
      const wanted = () => attempt.current === mine;
      void sharing.createShare({ organizationId: pending.organizationId }, { shouldContinue: wanted }).then(async (created) => {
        creating.current = false;
        if (!created) { if (wanted()) setPending(null); return; }
        // Cancel raced a successful share: undo it rather than leave access on.
        if (!wanted()) { await sharing.stopShare(); return; }
        setPending(null);
        setRequired(false); setNotice(null);
        if (pending.reason === "completion") {
          setDone(true);
          if (!await handoff.markApplied()) await handoff.markApplied();
        }
      });
      return;
    }
    setPending(null);
    if (sharing.state === "blocked" || sharing.state === "stale") {
      setRequired(true);
      if (pending.reason === "completion") setNotice(NOT_READY_AFTER_CHAT);
    } else {
      setNotice(CHECK_FAILED);
    }
  }, [pending, sharing, handoff]);

  const running = record?.state === "running" && !shared;
  const step: OrganizationShareStep = shared ? (done ? "done" : "idle")
    : pending?.reason === "completion" ? "applying"
    : running ? "running"
    : pending ? "checking"
    : required ? "required"
    : "idle";

  return {
    step,
    shared,
    notice: notice ?? sharing.actionMessage,
    runningOrganizationId: running ? record!.organizationId : null,
    share(organizationId: string) {
      setNotice(null); setDone(false);
      attempt.current += 1;
      setPending({ organizationId, reason: "owner" });
      void sharing.recheck({ organizationId });
    },
    async startInChats(organizationId: string) {
      setNotice(null);
      const started = await handoff.start(organizationId);
      if (!started) { setNotice("Couldn’t start the chat. Try again."); return; }
      const ok = await onStartChat({ organizationId, requestId: started.requestId });
      if (!ok) { await handoff.cancel(); setNotice("Couldn’t start the chat. Try again."); }
    },
    async cancel() {
      attempt.current += 1;
      setNotice(null); setRequired(false); setPending(null);
      if (running) await handoff.cancel();
    },
    async stop() {
      attempt.current += 1;
      setDone(false); setNotice(null);
      const stopped = await sharing.stopShare();
      // Retire any saved completion so it can never turn sharing back on.
      if (stopped && record && record.state !== "cancelled") await handoff.cancel();
    },
    dismissDone: () => setDone(false),
  };
}

export type OrganizationShareFlow = ReturnType<typeof useOrganizationShareFlow>;
