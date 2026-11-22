"use client";
import { OwnedMachineNameSchema, type OwnedComputerSummary } from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Dialog } from "../Dialog";
import { DialogFooter } from "../DialogFooter";
import { DialogTitle } from "../DialogTitle";
import { InstallCommand, OwnedStatusDot, OwnedSwitch } from "./owned-computer-controls";
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
/** Bounded background refresh while the panel is open and the page is visible. */
const REFRESH_MS = 30_000;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; list: OwnedComputerList };

export interface OwnedComputersPanelProps {
  /** Changes when the signed-in identity changes, so state never leaks across accounts. */
  scope: string;
  transport: OwnedComputersTransport;
  /** Called after a rename, setting change or removal succeeds, so other computer lists can refresh. */
  onChanged?: () => void;
}

export function OwnedComputersPanel(props: OwnedComputersPanelProps) {
  return <OwnedComputersContent key={props.scope} transport={props.transport} onChanged={props.onChanged} />;
}

function logFailure(operation: OwnedComputersFailure, error: unknown) {
  console.warn(`[owned-computers] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
}

function OwnedComputersContent({ transport, onChanged }: { transport: OwnedComputersTransport; onChanged?: () => void }) {
  const client = useMemo(() => createOwnedComputersClient(transport), [transport]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [now, setNow] = useState(() => new Date());
  const [pending, setPending] = useState<Record<string, true>>({});
  const [failure, setFailure] = useState<{ machineId: string | null; kind: OwnedComputersFailure } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OwnedComputerSummary | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  // List loads never race changes: a load is applied only if no change was in
  // flight or started while it ran. A discarded load is retried once all
  // changes settle, so the list catches up with the server without ever
  // overwriting a saved reply or bringing back a removed computer.
  // Per-row sequences order overlapping requests for the same computer.
  const rowSequence = useRef<Record<string, number>>({});
  const loadController = useRef<AbortController | null>(null);
  const mutationsInFlight = useRef(0);
  const mutationEpoch = useRef(0);
  const reloadAfterMutations = useRef(false);

  const load = useCallback((mode: "initial" | "background") => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const epoch = mutationEpoch.current;
    client.list({ signal: controller.signal }).then(
      (list) => {
        if (controller.signal.aborted) return;
        if (mutationsInFlight.current > 0 || mutationEpoch.current !== epoch) {
          // Changes still running retry this load when they settle; if they
          // already settled, retry now with a load that starts after them.
          if (mutationsInFlight.current > 0) reloadAfterMutations.current = true;
          else load(mode);
          return;
        }
        setState({ status: "ready", list });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        logFailure("load", error);
        // A failed background refresh keeps the last good list on screen.
        if (mode === "initial") setState({ status: "error" });
      },
    );
  }, [client]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- Bounded, schema-validated owner inventory; loads are aborted on unmount and superseded by newer loads.
  useEffect(() => {
    load("initial");
    const refresh = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") load("background"); };
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      loadController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  function begin(machineId: string): { sequence: number } {
    const sequence = (rowSequence.current[machineId] ?? 0) + 1;
    rowSequence.current[machineId] = sequence;
    mutationsInFlight.current += 1;
    mutationEpoch.current += 1;
    setPending((current) => ({ ...current, [machineId]: true }));
    return { sequence };
  }

  function finish(machineId: string, sequence: number, changed: boolean) {
    mutationsInFlight.current -= 1;
    mutationEpoch.current += 1;
    if (mutationsInFlight.current === 0 && reloadAfterMutations.current) {
      reloadAfterMutations.current = false;
      load("background");
    }
    if (changed) onChanged?.();
    if (rowSequence.current[machineId] !== sequence) return;
    setPending((current) => {
      const next = { ...current };
      delete next[machineId];
      return next;
    });
  }

  async function update(computer: OwnedComputerSummary, patch: OwnedComputerUpdate, kind: OwnedComputersFailure): Promise<boolean> {
    const ticket = begin(computer.machineId);
    setFailure(null);
    let changed = false;
    try {
      const next = await client.update(computer.machineId, patch);
      changed = true;
      if (rowSequence.current[computer.machineId] === ticket.sequence) {
        setState((value) => (value.status === "ready" ? { status: "ready", list: replaceOwnedComputer(value.list, next) } : value));
      }
      return true;
    } catch (error: unknown) {
      logFailure(kind, error);
      if (rowSequence.current[computer.machineId] === ticket.sequence) setFailure({ machineId: computer.machineId, kind });
      return false;
    } finally {
      finish(computer.machineId, ticket.sequence, changed);
    }
  }

  async function confirmRemove() {
    const target = removeTarget;
    if (!target) return;
    const ticket = begin(target.machineId);
    setFailure(null);
    let changed = false;
    try {
      await client.remove(target.machineId);
      changed = true;
      setState((current) => (current.status === "ready" ? { status: "ready", list: withoutOwnedComputer(current.list, target.machineId) } : current));
      setRemoveTarget(null);
    } catch (error: unknown) {
      logFailure("remove", error);
      setFailure({ machineId: target.machineId, kind: "remove" });
      setRemoveTarget(null);
    } finally {
      finish(target.machineId, ticket.sequence, changed);
    }
  }

  if (state.status === "loading") {
    return <section aria-label="Your own computers" aria-busy="true" className="py-4 text-sm opacity-70">Loading your computers…</section>;
  }
  if (state.status === "error") {
    return (
      <section aria-label="Your own computers" className="flex flex-col items-start gap-3 py-4">
        <p role="alert" className="text-sm">{OWNED_COMPUTERS_FAILURE_COPY.load}</p>
        <Button variant="secondary" size="sm" onClick={() => { setState({ status: "loading" }); load("initial"); }}>Try again</Button>
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
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => load("background")}>Refresh</Button>
          {list.computers.length > 0 ? (
            <Button
              variant="primary"
              size="sm"
              disabled={atLimit}
              aria-describedby={atLimit ? "owned-computers-limit" : undefined}
              onClick={() => setShowInstall((value) => !value)}
            >
              Add a computer
            </Button>
          ) : null}
        </div>
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
              busy={pending[computer.machineId] === true}
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
          <Button variant="secondary" size="sm" onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={removeTarget !== null && pending[removeTarget.machineId] === true} onClick={() => { void confirmRemove(); }}>Remove</Button>
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
              <Input className="min-w-0 flex-1" aria-label="Computer name" value={draft} maxLength={64} autoFocus onChange={(event) => setDraft(event.target.value)} />
              <Button type="submit" variant="primary" size="sm" disabled={!draftValid || busy}>Save</Button>
              <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            </form>
          )}
          <p className="mt-1 truncate text-xs opacity-70">
            {ownedComputerLastSeenLabel(computer.lastSeenAt, now)}{platform ? ` · ${platform}` : ""}
          </p>
        </div>
        {draft === null ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Rename ${computer.name}`} onClick={() => setDraft(computer.name)}>Rename</Button>
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${computer.name}`} onClick={onRemove}>Remove</Button>
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
