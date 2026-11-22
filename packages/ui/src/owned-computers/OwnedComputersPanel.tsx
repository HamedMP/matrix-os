"use client";
import { OwnedMachineNameSchema, type OwnedComputerSummary } from "@matrix-os/contracts";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { DialogFooter } from "../DialogFooter";
import { DialogTitle } from "../DialogTitle";
import {
  InstallCommand,
  OwnedButton,
  OwnedInput,
  OwnedStatusDot,
  OwnedSwitch,
} from "./owned-computer-controls";
import {
  OWNED_COMPUTERS_FAILURE_COPY,
  createOwnedComputersClient,
  ownedComputerLastSeenLabel,
  ownedComputerPlatformLabel,
  ownedComputerStatusLabel,
  ownedComputersAtLimit,
  replaceOwnedComputer,
  withoutOwnedComputer,
  type OwnedComputerList,
  type OwnedComputerUpdate,
  type OwnedComputersFailure,
  type OwnedComputersTransport,
} from "./owned-computers-model";

const CLOCK_TICK_MS = 30_000;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; list: OwnedComputerList };

export interface OwnedComputersPanelProps {
  /** Changes when the signed-in identity changes, so state never leaks across accounts. */
  scope: string;
  transport: OwnedComputersTransport;
}

export function OwnedComputersPanel(props: OwnedComputersPanelProps) {
  return <OwnedComputersContent key={props.scope} transport={props.transport} />;
}

function logFailure(operation: OwnedComputersFailure, error: unknown) {
  console.warn(`[owned-computers] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
}

function OwnedComputersContent({ transport }: { transport: OwnedComputersTransport }) {
  const client = useMemo(() => createOwnedComputersClient(transport), [transport]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ machineId: string | null; kind: OwnedComputersFailure } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OwnedComputerSummary | null>(null);
  const [showInstall, setShowInstall] = useState(false);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- Bounded, schema-validated owner inventory; the surface transport carries the timeout and stale results are discarded on scope change.
  useEffect(() => {
    let active = true;
    client.list().then(
      (list) => { if (active) setState({ status: "ready", list }); },
      (error: unknown) => {
        logFailure("load", error);
        if (active) setState({ status: "error" });
      },
    );
    return () => { active = false; };
  }, [client, reload]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  async function update(computer: OwnedComputerSummary, patch: OwnedComputerUpdate, kind: OwnedComputersFailure): Promise<boolean> {
    setPending(computer.machineId);
    setFailure(null);
    try {
      const next = await client.update(computer.machineId, patch);
      setState((current) => (current.status === "ready" ? { status: "ready", list: replaceOwnedComputer(current.list, next) } : current));
      return true;
    } catch (error: unknown) {
      logFailure(kind, error);
      setFailure({ machineId: computer.machineId, kind });
      return false;
    } finally {
      setPending(null);
    }
  }

  async function confirmRemove() {
    const target = removeTarget;
    if (!target) return;
    setPending(target.machineId);
    setFailure(null);
    try {
      await client.remove(target.machineId);
      setState((current) => (current.status === "ready" ? { status: "ready", list: withoutOwnedComputer(current.list, target.machineId) } : current));
      setRemoveTarget(null);
    } catch (error: unknown) {
      logFailure("remove", error);
      setFailure({ machineId: target.machineId, kind: "remove" });
      setRemoveTarget(null);
    } finally {
      setPending(null);
    }
  }

  if (state.status === "loading") {
    return <section aria-label="Your own computers" aria-busy="true" className="py-4 text-sm opacity-70">Loading your computers…</section>;
  }
  if (state.status === "error") {
    return (
      <section aria-label="Your own computers" className="flex flex-col items-start gap-3 py-4">
        <p role="alert" className="text-sm">{OWNED_COMPUTERS_FAILURE_COPY.load}</p>
        <OwnedButton onClick={() => { setState({ status: "loading" }); setReload((value) => value + 1); }}>Try again</OwnedButton>
      </section>
    );
  }

  const { list } = state;
  const atLimit = ownedComputersAtLimit(list);
  return (
    <section aria-label="Your own computers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Your own computers</h3>
          <p className="text-xs opacity-70">Free Matrix computers on your laptop or server. {list.computers.length} of {list.limit} used.</p>
        </div>
        {list.computers.length > 0 ? (
          <OwnedButton
            variant="primary"
            disabled={atLimit}
            aria-describedby={atLimit ? "owned-computers-limit" : undefined}
            onClick={() => setShowInstall((value) => !value)}
          >
            Add a computer
          </OwnedButton>
        ) : null}
      </div>
      {atLimit ? (
        <p id="owned-computers-limit" className="text-xs opacity-70">
          You can connect up to {list.limit} of your own computers. Remove one to add another.
        </p>
      ) : null}
      {showInstall && !atLimit ? <InstallSteps /> : null}
      {failure && failure.machineId === null ? <p role="alert" className="text-xs">{OWNED_COMPUTERS_FAILURE_COPY[failure.kind]}</p> : null}
      {list.computers.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Connected computers">
          {list.computers.map((computer) => (
            <OwnedComputerRow
              key={computer.machineId}
              computer={computer}
              now={now}
              busy={pending === computer.machineId}
              failure={failure?.machineId === computer.machineId ? OWNED_COMPUTERS_FAILURE_COPY[failure.kind] : null}
              onUpdate={update}
              onRemove={() => setRemoveTarget(computer)}
            />
          ))}
        </ul>
      )}
      <Dialog open={removeTarget !== null} onClose={() => setRemoveTarget(null)} aria-label="Remove computer">
        <DialogTitle>Remove {removeTarget?.name ?? "computer"}?</DialogTitle>
        <p className="text-sm">
          Matrix stops reaching this computer right away, and its share links, sites and shared sessions stop working.
          Files and data stay on the machine itself.
        </p>
        <DialogFooter>
          <OwnedButton onClick={() => setRemoveTarget(null)}>Cancel</OwnedButton>
          <OwnedButton variant="destructive" disabled={pending !== null} onClick={() => { void confirmRemove(); }}>Remove</OwnedButton>
        </DialogFooter>
      </Dialog>
    </section>
  );
}

function InstallSteps() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--matrix-border,var(--border-subtle))] p-3">
      <p className="text-xs">Run this on the computer, then approve it in your browser when asked.</p>
      <InstallCommand />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--matrix-border,var(--border-subtle))] px-4 py-6 text-center">
      <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
      <h4 className="text-sm font-medium">Use your own computer, free</h4>
      <p className="max-w-sm text-xs opacity-70">
        Install Matrix on an always-on laptop or server and use it from here like a hosted computer.
      </p>
      <InstallCommand />
    </div>
  );
}

function OwnedComputerRow({
  computer,
  now,
  busy,
  failure,
  onUpdate,
  onRemove,
}: {
  computer: OwnedComputerSummary;
  now: Date;
  busy: boolean;
  failure: string | null;
  onUpdate: (computer: OwnedComputerSummary, patch: OwnedComputerUpdate, kind: OwnedComputersFailure) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftValid = draft !== null && OwnedMachineNameSchema.safeParse(draft).success;
  const platform = ownedComputerPlatformLabel(computer);

  async function saveName() {
    if (draft === null || !draftValid) return;
    const name = OwnedMachineNameSchema.parse(draft);
    if (name === computer.name) { setDraft(null); return; }
    if (await onUpdate(computer, { name }, "rename")) setDraft(null);
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-[var(--matrix-border,var(--border-subtle))] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {draft === null ? (
            <div className="flex items-center gap-2">
              <OwnedStatusDot status={computer.status} />
              <span className="truncate text-sm font-medium">{computer.name}</span>
              <span className="text-xs opacity-70">{ownedComputerStatusLabel(computer.status)}</span>
            </div>
          ) : (
            <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
              <OwnedInput aria-label="Computer name" value={draft} maxLength={64} autoFocus onChange={(event) => setDraft(event.target.value)} />
              <OwnedButton type="submit" variant="primary" disabled={!draftValid || busy}>Save</OwnedButton>
              <OwnedButton onClick={() => setDraft(null)}>Cancel</OwnedButton>
            </form>
          )}
          <p className="mt-1 truncate text-xs opacity-70">
            {ownedComputerLastSeenLabel(computer.lastSeenAt, now)}{platform ? ` · ${platform}` : ""}
          </p>
        </div>
        {draft === null ? (
          <div className="flex items-center gap-1">
            <OwnedButton variant="ghost" disabled={busy} aria-label={`Rename ${computer.name}`} onClick={() => setDraft(computer.name)}>Rename</OwnedButton>
            <OwnedButton variant="ghost" disabled={busy} aria-label={`Remove ${computer.name}`} onClick={onRemove}>Remove</OwnedButton>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 text-xs">
        <label className="flex items-center justify-between gap-3">
          <span>Automatic security updates</span>
          <OwnedSwitch
            label={`Automatic security updates for ${computer.name}`}
            checked={computer.autoSecurityUpdates}
            disabled={busy}
            onCheckedChange={(checked) => { void onUpdate(computer, { autoSecurityUpdates: checked }, "update"); }}
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>Back up to Matrix (1 GB)</span>
          <OwnedSwitch
            label={`Back up ${computer.name} to Matrix`}
            checked={computer.backupsEnabled}
            disabled={busy}
            onCheckedChange={(checked) => { void onUpdate(computer, { backupsEnabled: checked }, "update"); }}
          />
        </label>
      </div>
      {failure ? <p role="alert" className="text-xs">{failure}</p> : null}
    </li>
  );
}
