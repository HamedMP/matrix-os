import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BotRoutineCenterResponse, BotRoutineCenterQuery, BotRoutineDetailResponse, BotRoutineCenterItem } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../client.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { InteractionCard } from "./InteractionCard.js";
import { routineScheduleCopy, routineApprovalPreview } from "./routine-presentation.js";
import { ScheduleEditForm } from "./ScheduleEditForm.js";

const unavailable = "Schedules could not be loaded. Refresh and try again.";
function timestamp(value: string | null) {
  return value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "None scheduled";
}
function nextRun(row: BotRoutineCenterItem) {
  if (row.status === "archived") return "No future runs · archived";
  if (row.status === "paused") return "No future runs · paused";
  if (row.requiresReview || !row.targetAvailable || !row.sourceAvailable) return "Review required before execution";
  return timestamp(row.nextFireAt);
}
function statusLabel(row: BotRoutineCenterItem) {
  if (row.status === "archived") return "Archived";
  if (!row.targetAvailable) return "Target unavailable";
  if (row.requiresReview || !row.sourceAvailable) return "Needs review";
  if (row.lastFire?.status === "uncertain") return "Execution uncertain";
  if (row.lastFire && ["claimed", "dispatched"].includes(row.lastFire.status)) return "Running";
  if (row.status === "paused") return row.lastFire?.status === "failed" ? "Paused after failure" : "Paused";
  return row.lastFire?.status === "failed" ? "Active · last run failed" : "Active";
}

/** Owner-scoped API, same retained Chat navigation on every web/Electron shell. */
export function ScheduleCenter({ client, onClose, onOpenBotChat, headerLeading }: {
  client: ChatAgentClient; onClose(): void; onOpenBotChat?: (chatId: string) => void | Promise<void>; headerLeading?: ReactNode;
}) {
  const api = client.bots?.routines;
  const [data, setData] = useState<BotRoutineCenterResponse | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<BotRoutineCenterQuery>({});
  const currentQuery = useRef(query);
  const detailIntent = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<BotRoutineDetailResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState<BotRoutineCenterItem | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const lifetime = useRef(0);
  const reads = useRef(0);
  const current = useRef(client);
  useEffect(() => {
    current.current = client;
    lifetime.current += 1;
    return () => { lifetime.current += 1; };
  }, [client]);
  async function load(next = currentQuery.current) {
    if (!api) { setLoading(false); setError(unavailable); return; }
    const generation = lifetime.current, sequence = ++reads.current;
    setLoading(true); setError("");
    try {
      const result = await api.list(next);
      if (generation !== lifetime.current || current.current !== client || sequence !== reads.current) return;
      setData(result); setListRevision(sequence);
    } catch (failure: unknown) {
      console.warn("[schedules] List unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === lifetime.current && sequence === reads.current) setError(unavailable);
    } finally {
      if (generation === lifetime.current && sequence === reads.current) setLoading(false);
    }
  }
  useEffect(() => { void load(query); }, [api, query]);
  useEffect(() => {
    let active = true;
    void client.list().then(value => {
      if (active) setNames(Object.fromEntries(value.agents.slice(0, 200).map(agent => [agent.id, agent.name])));
    }).catch((failure: unknown) => {
      console.warn("[schedules] Bot names unavailable:", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [client]);
  async function act<T>(operation: () => Promise<T>, after?: (result: T) => void, refresh = true) {
    if (busy.current) return;
    const generation = lifetime.current;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await operation();
      if (generation !== lifetime.current || current.current !== client) return;
      after?.(result);
      if (refresh) await load();
    } catch (failure: unknown) {
      console.warn("[schedules] Action unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === lifetime.current) setError("Could not complete this action. Refresh before trying again; your edits are kept.");
    } finally {
      busy.current = false;
      if (generation === lifetime.current) setPending(false);
    }
  }
  const control = (row: BotRoutineCenterItem, status: "active" | "paused" | "archived") => api && act(
    () => api.control(row.routineId, { status, baseRevision: row.revision }),
    result => {
      setArchiving(null);
      setData(current => current ? { ...current, items: current.items.flatMap(item => {
        if (item.routineId !== row.routineId || item.revision !== row.revision) return [item];
        if (result.status === "archived" && currentQuery.current.archived !== "true") return [];
        return [{ ...item, status: result.status, revision: result.revision }];
      }) } : current);
      if (status === "archived" && detail?.routine.routineId === row.routineId) { detailIntent.current += 1; setDetail(null); setEditing(false); }
      else setDetail(current => current?.routine.routineId === row.routineId && current.routine.revision === row.revision
        ? { ...current, routine: { ...current.routine, status: result.status, revision: result.revision } } : current);
    },
  );
  function chooseFilter(next: BotRoutineCenterQuery) {
    currentQuery.current = next; reads.current += 1; detailIntent.current += 1;
    setDetail(null); setEditing(false); setData(null); setLoading(true); setQuery(next);
  }
  async function view(row: BotRoutineCenterItem) {
    if (!api) return;
    const intent = ++detailIntent.current, generation = lifetime.current;
    await act(async () => {
      const result = await api.detail(row.routineId);
      if (current.current === client && lifetime.current === generation && detailIntent.current === intent) { setDetail(result); setEditing(false); }
    });
  }
  async function refreshSelected() {
    if (!api) return;
    const selected = detail?.routine.routineId, intent = detailIntent.current, generation = lifetime.current;
    await act(async () => {
      await Promise.all([load(), selected ? api.detail(selected).then(result => {
        if (current.current === client && lifetime.current === generation && detailIntent.current === intent) setDetail(result);
      }) : Promise.resolve()]);
    }, undefined, false);
  }
  const rowButtons = (row: BotRoutineCenterItem) => row.status !== "archived" ? <div className="flex flex-wrap gap-2">
    <button type="button" className={chatAgentButtonClass} disabled={pending || row.status === "paused" && (!row.sourceAvailable || row.requiresReview || !row.targetAvailable)}
      aria-label={`${row.status === "active" ? "Pause" : "Resume"} ${row.proposal.name}`}
      onClick={() => void control(row, row.status === "active" ? "paused" : "active")}>{row.status === "active" ? "Pause" : "Resume"}</button>
    <button type="button" className={chatAgentButtonClass} disabled={pending} aria-label={`Archive ${row.proposal.name}`} onClick={() => setArchiving(row)}>Archive</button>
  </div> : null;
  return <section aria-label="Schedules" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
      <div className="flex min-w-0 items-start gap-2">{headerLeading}<div><h1 className="text-lg font-semibold">Schedules</h1><p className="text-sm" style={chatAgentMutedStyle}>Your tasks on this Computer. Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p></div></div>
      <button type="button" className={chatAgentButtonClass} aria-label="Close schedules" onClick={onClose}>Close</button>
    </header>
    <div className="my-4 flex flex-wrap gap-2">
      <button type="button" className={chatAgentButtonClass} aria-pressed={query.archived !== "true"} onClick={() => chooseFilter({})}>Current</button>
      <button type="button" className={chatAgentButtonClass} aria-pressed={query.archived === "true"} onClick={() => chooseFilter({ archived: "true" })}>Archived</button>
      <button type="button" className={chatAgentButtonClass} disabled={pending || loading} onClick={() => void refreshSelected()}>Refresh</button>
    </div>
    {error ? <p role="alert" className="mb-3 text-sm">{error}</p> : null}
    {loading ? <p role="status">Loading schedules…</p> : null}
    {archiving ? <section role="dialog" aria-label="Archive schedule" className="mb-4 grid gap-3 rounded-xl border p-4">
      <h2 className="font-semibold">Archive {archiving.proposal.name}?</h2><p>No future runs will start. Any active run will be cancelled. History remains available.</p>
      <div className="flex flex-wrap gap-2"><button className={chatAgentButtonClass} type="button" disabled={pending} onClick={() => void control(archiving, "archived")}>Confirm archive</button>
        <button className={chatAgentButtonClass} type="button" disabled={pending} onClick={() => setArchiving(null)}>Keep schedule</button></div>
    </section> : null}
    {detail ? <section aria-label="Schedule details" className="mb-4 grid min-w-0 gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap justify-between gap-2"><h2 className="break-words font-semibold">{detail.routine.proposal.name}</h2><button type="button" className={chatAgentButtonClass} onClick={() => { detailIntent.current += 1; setDetail(null); setEditing(false); }}>Close details</button></div>
      <p className="whitespace-pre-wrap break-words text-sm">{detail.routine.proposal.prompt}</p>
      <p className="text-sm">{statusLabel(detail.routine)} · Next run: {nextRun(detail.routine)}</p>
      {rowButtons(detail.routine)}
      <div className="flex flex-wrap gap-2">
        {onOpenBotChat && detail.routine.targetAvailable ? <button className={chatAgentButtonClass} type="button" disabled={pending} onClick={() => void act(async () => { await onOpenBotChat(detail.routine.chatId); }, onClose, false)}>Open Bot Chat</button> : null}
        {detail.routine.status !== "archived" ? <button type="button" className={chatAgentButtonClass} disabled={pending || !detail.routine.targetAvailable || !detail.routine.sourceAvailable} onClick={() => setEditing(true)}>Edit schedule</button> : null}
      </div>
      {editing && api ? <ScheduleEditForm key={detail.routine.routineId} routine={detail.routine} api={api} botClient={client.bots!} agentName={names[detail.routine.botId]} pendingReadRevision={listRevision} getPendingReadSequence={() => reads.current} pendingInteractions={data?.pending ?? []} onChanged={() => { detailIntent.current += 1; setEditing(false); setDetail(null); void load(); }}/>: null}
      <h3 className="mt-2 font-semibold">Recent runs</h3>
      {!detail.history.length ? <p className="text-sm">No runs yet.</p> : <ol className="grid gap-2">{detail.history.map(fire => <li key={fire.fireId} className="rounded-lg border p-3 text-sm">
        <p>{timestamp(fire.scheduledFor)} · {fire.status} · {fire.attempts} attempt{fire.attempts === 1 ? "" : "s"}</p>
        {fire.failureCode ? <p>Execution did not complete. Open Bot Chat for details.</p> : null}
      </li>)}</ol>}
    </section> : null}
    {data && !loading ? <>
      {query.archived !== "true" && data.pending.length ? <section aria-label="Awaiting your approval" className="mb-4 grid gap-3"><h2 className="font-semibold">Awaiting your approval</h2>
        {data.pending.map(item => {
          const preview = item.payload?.kind === "approval" ? routineApprovalPreview(item.payload.preview) : null;
          const target = preview?.source.routineId ? data.items.find(row => row.routineId === preview.source.routineId) : undefined;
          const revision = preview?.source.routineId ? target?.targetAvailable && target.sourceAvailable && !target.requiresReview ? target.revision : null : undefined;
          return <InteractionCard key={item.interactionId} interaction={item} agentName={names[item.agentId]} actionsAvailable={!pending} currentRoutineRevision={revision}
            onResolve={input => client.bots!.resolve(item.chatId, item.interactionId, input)} onResolved={() => void load()}/>;
        })}</section> : null}
      {!data.items.length ? <div className="rounded-xl border p-6"><h2 className="font-semibold">{query.archived === "true" ? "No archived schedules" : "No schedules yet"}</h2><p className="mt-2 text-sm" style={chatAgentMutedStyle}>Ask a private Bot Chat to schedule a task, then review and approve it here or in Chat.</p></div> : <ul className="grid min-w-0 gap-3">
        {data.items.map(row => { const copy = routineScheduleCopy(row.proposal.schedule); return <li key={row.routineId} className="grid min-w-0 gap-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><button type="button" className="text-left font-semibold" aria-label={`View ${row.proposal.name}`} disabled={pending} onClick={() => void view(row)}>{row.proposal.name}</button><span className="rounded-full border px-2 py-1 text-xs">{statusLabel(row)}</span></div>
          <p className="whitespace-pre-wrap break-words text-sm">{row.proposal.prompt}</p>
          <p className="break-words text-xs" style={chatAgentMutedStyle}>{names[row.botId] ?? (row.targetAvailable ? "Private Bot" : "Bot unavailable")} · {row.computerId ?? "Computer unavailable"}</p>
          <p className="break-words text-sm">{copy.frequency} · {copy.timezone}</p><p className="text-xs" style={chatAgentMutedStyle}>Next run: {nextRun(row)}{row.lastFire ? ` · Last run: ${row.lastFire.status}` : " · Not run yet"}</p>
          {rowButtons(row)}
        </li>; })}
      </ul>}
      {data.nextCursor ? <button type="button" className={`${chatAgentButtonClass} mt-4`} onClick={() => chooseFilter({ ...data.nextCursor!, ...(query.archived ? { archived: query.archived } : {}) })}>Next page</button> : null}
    </> : null}
  </section>;
}
