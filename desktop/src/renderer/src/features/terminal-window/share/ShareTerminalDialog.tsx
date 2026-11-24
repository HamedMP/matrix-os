// Spec 2710 J1/J6: the owner shares one terminal with people in their
// organization as Viewer or Editor, and can stop sharing at any time.
import { useCallback, useEffect, useRef, useState } from "react";
import { AudienceGrantPicker, Button, Dialog, DialogFooter, DialogTitle, Input } from "@matrix-os/ui";
import type { CollaborationScope } from "@matrix-os/contracts";
import { computerRuntimeId, useTeamCollaborationState, type TeamCollaboration, type TeamCollaborationState, type TeamOrganization } from "./use-team-collaboration";
import { findTeamTerminal, prepareTeamTerminal, stopSharingTeamTerminal, syncEditorTyping } from "./team-share";

export interface ShareTarget {
  slot: string;
  /** Canonical `workspaceId:tabId`. */
  terminalId: string;
  title: string;
  /** The owner's name for this computer, the default members see. */
  computerLabel: string;
}

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const MAX_LABEL = 64;

type Step =
  | { kind: "loading" }
  | { kind: "confirm" }
  | { kind: "working" }
  | { kind: "shared"; scope: CollaborationScope; error?: string }
  | { kind: "failed"; message: string };

const FAILED = "Couldn't share this terminal. Check that the computer is online and try again.";
const TYPING_FAILED = "Access is saved, but Editors may not be able to type yet. Retry to finish.";
const STOP_FAILED = "Couldn't stop sharing. Some people may still have access; try again.";

export function ShareTerminalDialog({ target, platformHost, team: teamClient, onClose }: {
  target: ShareTarget | null;
  platformHost: string | null;
  team: TeamCollaboration;
  onClose(): void;
}) {
  const teamState = useTeamCollaborationState(teamClient, target !== null);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [label, setLabel] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const ready = teamState.status === "ready" ? teamState : null;
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

  if (!target) return null;
  const editing = step.kind === "confirm" || step.kind === "failed";
  return (
    <Dialog open onClose={onClose} aria-label={`Share ${target.title}`} style={{ padding: 16, maxWidth: 560 }}>
      <DialogTitle>Share “{target.title}”</DialogTitle>
      <TeamStatus status={teamState.status} />
      {ready ? (
        <div className="mt-2 flex flex-col gap-3 text-[13px]">
          <p role="note" className="rounded-md border p-2.5" style={{ borderColor: "var(--color-warning, #f59e0b)" }}>
            A shared terminal is full shell access. Everyone you add sees everything it prints, including secrets.
            Editors can type and run any command as you on this computer. Share terminals on a team computer, not a personal one.
          </p>
          <StepStatus step={step} />
          {editing ? <ShareSetup organizations={ready.organizations} organizationId={organizationId} onOrganization={setOrganizationId}
            label={label} onLabel={setLabel} /> : null}
          {step.kind === "shared" ? (
            <>
              {step.error ? (
                <div role="alert" className="flex flex-wrap items-center gap-2">
                  {step.error}
                  {step.error === TYPING_FAILED ? <Button size="sm" variant="secondary" onClick={() => { void syncTyping(step.scope); }}>Retry</Button> : null}
                </div>
              ) : null}
              <AudienceGrantPicker api={ready.api} scope={step.scope} onRefresh={() => syncTyping(step.scope)} />
            </>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        {step.kind === "shared" ? <Button variant="destructive" onClick={() => { void stop(step.scope); }}>Stop sharing</Button> : null}
        {ready && editing
          ? <Button variant="primary" disabled={!label.trim() || !organizationId} onClick={() => { void share(); }}>Share terminal</Button> : null}
        <Button variant="secondary" onClick={onClose}>{step.kind === "shared" ? "Done" : "Cancel"}</Button>
      </DialogFooter>
    </Dialog>
  );
}

function TeamStatus({ status }: { status: TeamCollaborationState["status"] }) {
  if (status === "none") return <p className="mt-2 text-[13px]">Join or create an organization in the main window to share terminals with teammates.</p>;
  if (status === "failed") return <p role="alert" className="mt-2 text-[13px]">Sharing is unavailable right now. Try again later.</p>;
  if (status === "loading") return <p role="status" className="mt-2 text-[13px]" style={secondaryText}>Loading your organization…</p>;
  return null;
}

function StepStatus({ step }: { step: Step }) {
  if (step.kind === "loading" || step.kind === "working") {
    return <p role="status" style={secondaryText}>{step.kind === "loading" ? "Checking this terminal…" : "Working…"}</p>;
  }
  return step.kind === "failed" ? <p role="alert">{step.message}</p> : null;
}

function ShareSetup({ organizations, organizationId, onOrganization, label, onLabel }: {
  organizations: readonly TeamOrganization[];
  organizationId: string | null;
  onOrganization(id: string): void;
  label: string;
  onLabel(value: string): void;
}) {
  return (
    <>
      {organizations.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Organization">
          {organizations.map((organization) => (
            <Button key={organization.organizationId} size="sm" role="radio" aria-checked={organization.organizationId === organizationId}
              variant={organization.organizationId === organizationId ? "primary" : "secondary"}
              onClick={() => onOrganization(organization.organizationId)}>{organization.name}</Button>
          ))}
        </div>
      ) : <p style={secondaryText}>Shared within {organizations[0]?.name}.</p>}
      <label className="flex flex-col gap-1">
        <span>Computer name teammates see</span>
        <Input value={label} maxLength={MAX_LABEL} aria-label="Computer name teammates see"
          onChange={(event) => onLabel(event.target.value)} />
      </label>
    </>
  );
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
