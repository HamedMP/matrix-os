// Spec 2710 J1/J6: the owner shares one terminal with people in their
// organization as Viewer or Editor, and can stop sharing at any time.
import { AudienceGrantPicker, Button, Dialog, DialogFooter, DialogTitle, Input, type CollaborationDirectApi } from "@matrix-os/ui";
import type { CollaborationScope } from "@matrix-os/contracts";
import { useTeamCollaborationState, type TeamCollaboration, type TeamCollaborationState, type TeamOrganization } from "./use-team-collaboration";
import { MAX_LABEL, TYPING_FAILED, useShareFlow, type ShareStep } from "./use-share-flow";
import { ComputerShareToggle } from "./ComputerShareToggle";

export interface ShareTarget {
  slot: string;
  /** Canonical `workspaceId:tabId`. */
  terminalId: string;
  title: string;
  /** The owner's name for this computer, the default members see. */
  computerLabel: string;
}

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
export function ShareTerminalDialog({ target, platformHost, team: teamClient, onClose }: {
  target: ShareTarget | null;
  platformHost: string | null;
  team: TeamCollaboration;
  onClose(): void;
}) {
  const teamState = useTeamCollaborationState(teamClient, target !== null);
  const ready = teamState.status === "ready" ? teamState : null;
  const { step, label, setLabel, organizationId, setOrganizationId, share, stop, syncTyping } = useShareFlow(target, platformHost, ready);
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
          {step.kind === "shared" ? <SharedAccess api={ready.api} step={step} onSyncTyping={syncTyping} /> : null}
        </div>
      ) : null}
      <ShareFooter step={step} canShare={Boolean(ready && editing && label.trim() && organizationId)} showShare={Boolean(ready && editing)}
        onShare={() => { void share(); }} onStop={(scope) => { void stop(scope); }} onClose={onClose} />
    </Dialog>
  );
}

function TeamStatus({ status }: { status: TeamCollaborationState["status"] }) {
  if (status === "none") return <p className="mt-2 text-[13px]">Join or create an organization in the main window to share terminals with teammates.</p>;
  if (status === "failed") return <p role="alert" className="mt-2 text-[13px]">Sharing is unavailable right now. Try again later.</p>;
  if (status === "loading") return <p role="status" className="mt-2 text-[13px]" style={secondaryText}>Loading your organization…</p>;
  return null;
}

function StepStatus({ step }: { step: ShareStep }) {
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


function SharedAccess({ api, step, onSyncTyping }: {
  api: CollaborationDirectApi;
  step: Extract<ShareStep, { kind: "shared" }>;
  onSyncTyping(scope: CollaborationScope): Promise<void>;
}) {
  return (
    <>
      {step.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          {step.error}
          {step.error === TYPING_FAILED ? <Button size="sm" variant="secondary" onClick={() => { void onSyncTyping(step.scope); }}>Retry</Button> : null}
        </div>
      ) : null}
      <AudienceGrantPicker api={api} scope={step.scope} onRefresh={() => onSyncTyping(step.scope)} />
      <ComputerShareToggle api={api} scopeId={step.scope.id} />
    </>
  );
}

function ShareFooter({ step, canShare, showShare, onShare, onStop, onClose }: {
  step: ShareStep;
  canShare: boolean;
  showShare: boolean;
  onShare(): void;
  onStop(scope: CollaborationScope): void;
  onClose(): void;
}) {
  return (
    <DialogFooter>
      {step.kind === "shared" ? <Button variant="destructive" onClick={() => onStop(step.scope)}>Stop sharing</Button> : null}
      {showShare ? <Button variant="primary" disabled={!canShare} onClick={onShare}>Share terminal</Button> : null}
      <Button variant="secondary" onClick={onClose}>{step.kind === "shared" ? "Done" : "Cancel"}</Button>
    </DialogFooter>
  );
}
