import { useRoutineAction } from "./use-routine-action.js";
import { useEffect, useLayoutEffect, useState } from "react";
import { ROUTINE_ACTION_NOTICE, ROUTINE_ACTION_OUTCOME as outcome, routineActionDetails, type RoutineActionView } from "@matrix-os/contracts";
import type { RoutineActionClient } from "./client.js";

/** Shared Web Canvas/Web Desktop/Electron Desktop/owner-browser card. Native Mobile uses the same server DTO/copy. */
export function RoutineActionConfirmation({ client, challengeId, identity, openConfirmation }: {
  client: RoutineActionClient; challengeId: string; identity: string; openConfirmation?: (id: string, signal?: AbortSignal) => Promise<void>;
}) {
  const { view, status, error, busy, opened, active, submit } = useRoutineAction({ client, challengeId, identity, openConfirmation });
  return <section aria-label="Routine operation confirmation" className="space-y-3 rounded-xl border p-4 text-sm">
    <p className="font-semibold">{view?.title ?? "Routine operation confirmation"}</p>
    <p>{ROUTINE_ACTION_NOTICE}</p>
    {view ? <pre className="whitespace-pre-wrap break-words font-sans">{routineActionDetails(view)}</pre> : null}
    <p role="status">{status ? outcome[status] : "Loading confirmation…"}</p>
    {active ? <div className="flex flex-wrap gap-2">{openConfirmation
      ? <button type="button" disabled={busy} onClick={() => void submit("approve")}>{opened ? "Reopen owner confirmation" : "Confirm in browser"}</button>
      : (["approve", "decline", "cancel"] as const).map(decision => <button type="button" key={decision} disabled={busy} onClick={() => void submit(decision)}>{decision === "approve" ? "Allow once" : decision === "decline" ? "Decline" : "Cancel request"}</button>)}</div> : null}
    {opened && active ? <p>Complete the decision in your owner browser. Opening it does not allow the operation.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
export function RoutineActionInbox({ client, identity, openConfirmation }: { client: RoutineActionClient; identity: string; openConfirmation?: (id: string, signal?: AbortSignal) => Promise<void> }) {
  const [fresh, setFresh] = useState(false);
  const [open, setOpen] = useState(false), [views, setViews] = useState<RoutineActionView[]>([]), [selected, setSelected] = useState<string | null>(null), [error, setError] = useState(false);
  useLayoutEffect(() => { setSelected(null); setViews([]); setFresh(false); setError(false); }, [identity, client]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController(); let reading = false;
    const read = async () => { if (reading) return; reading = true;
      try { const result = await client.list(abort.signal); if (!abort.signal.aborted) { setViews(result); setFresh(true); setError(false); } }
      catch (failure: unknown) { console.warn("[routine-action] Inbox unavailable", failure instanceof Error ? failure.name : "UnknownError"); if (!abort.signal.aborted) { setFresh(false); setError(true); } }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 2000); return () => { abort.abort(); clearInterval(timer); };
  }, [client, identity, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Routine confirmations</summary>
    {open ? <div>{error ? <p role="alert">Routine confirmations unavailable. Refresh to check again.</p> : !fresh ? <p role="status">Loading confirmations…</p> : !views.length ? <p>No pending routine confirmations on this Computer.</p>
      : views.map(view => <button type="button" key={view.challengeId} onClick={() => setSelected(view.challengeId)}>{view.title} · {outcome[view.status]}</button>)}
      {selected ? <RoutineActionConfirmation key={`${identity}:${selected}`} client={client} challengeId={selected} identity={identity} openConfirmation={openConfirmation}/> : null}
    </div> : null}
  </details>;
}
