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
  createShare(input: { organizationId: string }): Promise<CollaborativeAppShare | null>;
  stopShare(): Promise<CollaborativeAppShare | null>;
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
    if (record.state !== "completed" || shared || !sharing.shareKnown) return;
    handledCompletion.current = record.requestId;
    setPending({ organizationId: record.organizationId, reason: "completion" });
    void sharing.recheck({ organizationId: record.organizationId });
  }, [record, shared, sharing]);

  // Apply a share only when the recheck we asked for settles as ready.
  // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- synchronizes with the async readiness hook; the share must follow its server result.
  useEffect(() => {
    if (!pending || sharing.state === "checking" || sharing.state === "loading" || creating.current) return;
    if (sharing.state === "ready") {
      creating.current = true;
      void sharing.createShare({ organizationId: pending.organizationId }).then(async (created) => {
        creating.current = false;
        setPending(null);
        if (!created) return;
        setRequired(false); setNotice(null);
        if (pending.reason === "completion") { setDone(true); await handoff.markApplied(); }
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
      setNotice(null); setRequired(false); setPending(null);
      if (running) await handoff.cancel();
    },
    async stop() {
      setDone(false); setNotice(null);
      await sharing.stopShare();
    },
    dismissDone: () => setDone(false),
  };
}

export type OrganizationShareFlow = ReturnType<typeof useOrganizationShareFlow>;
