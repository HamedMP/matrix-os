import { useEffect, useRef, useState } from "react";
import type { CollaborativeAppReadiness, CollaborativeAppShare } from "@matrix-os/contracts";
import type { CollaborativeHandoff } from "./use-collaborative-handoff";

/** The subset of `useCollaborativeAppSharing` the flow drives (spec 2689 readiness = single source of truth). */
export interface OrganizationSharing {
  share: CollaborativeAppShare | null;
  shareKnown: boolean;
  /** The current build's readiness, when loaded. */
  readiness: CollaborativeAppReadiness | null;
  state: "idle" | "loading" | "checking" | "blocked" | "ready" | "stale" | "failed";
  /** The current build is collaborative (readiness `ready`), so members can edit. */
  collaborative: boolean;
  actionState: "idle" | "loading" | "sharing" | "stopping" | "failed";
  actionMessage: string | null;
  recheck(input: { organizationId: string }): Promise<void>;
  createShare(input: { organizationId: string }, options?: { shouldContinue?: () => boolean }): Promise<CollaborativeAppShare | null>;
  stopShare(): Promise<CollaborativeAppShare | null>;
  refreshShare(): Promise<unknown>;
}

export type OrganizationShareStep = "idle" | "checking" | "running" | "applying" | "done";

/** `refresh`: an already-shared app's completion only refreshes readiness, for exactly that request. */
interface Pending { organizationId: string; reason: "owner" | "completion" | "refresh"; requestId?: string }

const NOT_READY_AFTER_CHAT = "Claude finished, but the app isn’t collaborative yet. Open the chat to keep going.";
const CHECK_FAILED = "Couldn’t check this app right now. Try again.";

/**
 * Org sharing (ENG-579). Share always runs a fresh readiness check for the chosen organization and
 * shares when the check completes: `ready` gives members full use, `blocked` (the app isn't
 * collaborative) opens it view-only. "Make it collaborative" is an optional builder-skill handoff;
 * its completion event rechecks readiness, and shares only when the result is collaborative and the
 * app is not shared yet. The server preflight enforces the same completed-check rule.
 */
// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- one bounded org-share state machine (owner share, completion event, readiness settle); splitting it would duplicate the readiness invariant.
export function useOrganizationShareFlow({ sharing, handoff, onStartChat }: {
  sharing: OrganizationSharing;
  handoff: CollaborativeHandoff;
  onStartChat: (request: { organizationId: string; requestId: string }) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
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
      setNotice(NOT_READY_AFTER_CHAT);
      return;
    }
    if (record.state !== "completed") return;
    if (shared) {
      // Already shared: refresh readiness so the collaborative tick follows the rebuilt app. The
      // record is retired only after a completed check, and only while it is still this request.
      handledCompletion.current = record.requestId;
      attempt.current += 1;
      setPending({ organizationId: record.organizationId, reason: "refresh", requestId: record.requestId });
      void sharing.recheck({ organizationId: record.organizationId });
      return;
    }
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

  // Apply a share only when the recheck we asked for settles as a completed check.
  // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- synchronizes with the async readiness hook; the share must follow its server result.
  useEffect(() => {
    if (!pending || sharing.state === "checking" || sharing.state === "loading" || creating.current) return;
    if (pending.reason === "refresh") {
      setPending(null);
      if (sharing.state !== "ready" && sharing.state !== "blocked") {
        // The completion stays saved, so the next load retries it.
        setNotice(CHECK_FAILED);
        return;
      }
      // A newer "Start in Chats" request must never be overwritten by this older completion.
      const current = handoff.record;
      if (current && current.requestId === pending.requestId && current.state === "completed") void handoff.markApplied();
      return;
    }
    const shareable = pending.reason === "owner"
      ? sharing.state === "ready" || sharing.state === "blocked"
      : sharing.state === "ready";
    if (shareable) {
      creating.current = true;
      const mine = attempt.current;
      const wanted = () => attempt.current === mine;
      void sharing.createShare({ organizationId: pending.organizationId }, { shouldContinue: wanted }).then(async (created) => {
        creating.current = false;
        // A cancelled attempt returns null: createShare stops before the share
        // request, or revokes the share it just created when cancel raced it.
        if (!created) { if (wanted()) setPending(null); return; }
        setPending(null);
        setNotice(null);
        if (pending.reason === "completion") {
          setDone(true);
          if (!await handoff.markApplied()) await handoff.markApplied();
        }
      });
      return;
    }
    setPending(null);
    setNotice(pending.reason === "completion" && sharing.state === "blocked" ? NOT_READY_AFTER_CHAT : CHECK_FAILED);
  }, [pending, sharing, handoff]);

  const running = record?.state === "running" && !sharing.collaborative;
  const step: OrganizationShareStep = shared && done ? "done"
    : pending?.reason === "completion" ? "applying"
    : pending ? "checking"
    : running ? "running"
    : "idle";

  return {
    step,
    shared,
    collaborative: sharing.collaborative,
    /** Confirmed view-only: the share is bound to the current build's blocked readiness. Unknown readiness is not view-only. */
    viewOnly: shared && sharing.readiness?.status === "blocked" && sharing.readiness.readinessId === sharing.share?.readinessId,
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
      setNotice(null); setPending(null);
      if (record?.state === "running") await handoff.cancel();
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
