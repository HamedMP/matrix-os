// Spec 2710 J1/J6: the Share dialog's steps, kept apart from its markup.
// Every request remembers the dialog it started in; a result for an earlier
// target, or for a dialog that closed, is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import type { CollaborationScope } from "@matrix-os/contracts";
import { computerRuntimeId, type TeamOrganization } from "./use-team-collaboration";
import { findTeamTerminal, prepareTeamTerminal, stopSharingTeamTerminal, syncEditorTyping } from "./team-share";
import type { ShareTarget } from "./ShareTerminalDialog";

export const MAX_LABEL = 64;

export type ShareStep =
  | { kind: "loading" }
  | { kind: "confirm" }
  | { kind: "working" }
  | { kind: "shared"; scope: CollaborationScope; error?: string }
  | { kind: "failed"; message: string };
type Step = ShareStep;

const FAILED = "Couldn't share this terminal. Check that the computer is online and try again.";
export const TYPING_FAILED = "Access is saved, but Editors may not be able to type yet. Retry to finish.";
const STOP_FAILED = "Couldn't stop sharing. Some people may still have access; try again.";

export function useShareFlow(
  target: ShareTarget | null,
  platformHost: string | null,
  ready: { api: CollaborationDirectApi; organizations: TeamOrganization[] } | null,
) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [label, setLabel] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  // Results of requests started for an earlier target or before closing are dropped.
  const live = useRef(0);
  useEffect(() => {
    live.current += 1;
    return () => { live.current += 1; };
  }, [target]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- opening the dialog reads whether this tab is already shared; nothing is created until the owner confirms.
  useEffect(() => {
    if (!target || !ready || !platformHost) return;
    let active = true;
    const chosen = ready.organizations[0]?.organizationId ?? null;
    setOrganizationId(chosen);
    setLabel(target.computerLabel.slice(0, MAX_LABEL));
    setStep({ kind: "loading" });
    void (async () => {
      const runtimeId = await computerRuntimeId(platformHost, target.slot);
      if (!runtimeId || !chosen) throw new Error("runtime unavailable");
      // A tab is shared within at most one organization: look in each the person belongs to.
      const existing = await findAcrossOrganizations(ready, runtimeId, target.terminalId);
      if (!active) return;
      if (!existing) { setStep({ kind: "confirm" }); return; }
      if (existing.organizationId) setOrganizationId(existing.organizationId);
      setStep({ kind: "shared", scope: existing });
      // Finishes a typing setting an earlier session left unsaved.
      void syncEditorTyping(ready.api, existing.id).catch((error: unknown) => {
        console.warn("[terminal-window] typing sync failed:", error instanceof Error ? error.name : "UnknownError");
        if (active) setStep({ kind: "shared", scope: existing, error: TYPING_FAILED });
      });
    })().catch((error: unknown) => {
      console.warn("[terminal-window] share lookup failed:", error instanceof Error ? error.name : "UnknownError");
      if (active) setStep({ kind: "confirm" });
    });
    return () => { active = false; };
  }, [platformHost, ready, target]);

  const share = useCallback(async () => {
    if (!target || !ready || !platformHost || !organizationId || !label.trim()) return;
    const request = live.current;
    setStep({ kind: "working" });
    try {
      const runtimeId = await computerRuntimeId(platformHost, target.slot);
      if (!runtimeId) throw new Error("runtime unavailable");
      const scope = await prepareTeamTerminal(ready.api, { runtimeId, organizationId, terminalId: target.terminalId, computerLabel: label });
      if (request === live.current) setStep({ kind: "shared", scope });
    } catch (error: unknown) {
      console.warn("[terminal-window] share failed:", error instanceof Error ? error.name : "UnknownError");
      if (request === live.current) setStep({ kind: "failed", message: FAILED });
    }
  }, [label, organizationId, platformHost, ready, target]);

  const stop = useCallback(async (scope: CollaborationScope) => {
    if (!ready) return;
    const request = live.current;
    setStep({ kind: "working" });
    try {
      await stopSharingTeamTerminal(ready.api, scope.id);
      if (request === live.current) setStep({ kind: "confirm" });
    } catch (error: unknown) {
      console.warn("[terminal-window] stop sharing failed:", error instanceof Error ? error.name : "UnknownError");
      // The share is still in place: keep it, with Stop sharing to retry until every grant is gone.
      if (request === live.current) setStep({ kind: "shared", scope, error: STOP_FAILED });
    }
  }, [ready]);

  /** After each access change, and on Retry: editors can type only once the owner's setting is saved. */
  const syncTyping = useCallback(async (scope: CollaborationScope) => {
    if (!ready) return;
    const request = live.current;
    try {
      await syncEditorTyping(ready.api, scope.id);
      if (request === live.current) setStep({ kind: "shared", scope });
    } catch (error: unknown) {
      console.warn("[terminal-window] typing sync failed:", error instanceof Error ? error.name : "UnknownError");
      if (request === live.current) setStep({ kind: "shared", scope, error: TYPING_FAILED });
    }
  }, [ready]);

  return { step, label, setLabel, organizationId, setOrganizationId, share, stop, syncTyping };
}

async function findAcrossOrganizations(
  ready: { api: Parameters<typeof findTeamTerminal>[0]; organizations: readonly TeamOrganization[] },
  runtimeId: string,
  terminalId: string,
): Promise<CollaborationScope | null> {
  for (const organization of ready.organizations) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- at most a few organizations, and the first match ends the search.
      const found = await findTeamTerminal(ready.api, { runtimeId, organizationId: organization.organizationId, terminalId });
      if (found) return found;
    } catch (error: unknown) {
      // A share in another organization refuses this one's lookup: keep looking.
      console.warn("[terminal-window] share lookup skipped an organization:", error instanceof Error ? error.name : "UnknownError");
    }
  }
  return null;
}
