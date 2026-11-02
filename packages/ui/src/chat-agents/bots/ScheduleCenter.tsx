import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BotRoutineCenterResponse, BotRoutineCenterQuery, BotRoutineDetailResponse, BotRoutineCenterItem } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../client.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { routineScheduleCopy, routineNextRun as nextRun, routineStatusLabel as statusLabel } from "./routine-presentation.js";
import { ScheduleEditForm } from "./ScheduleEditForm.js";

const unavailable = "Schedules could not be loaded. Refresh and try again.";
/** Owner-scoped API, same retained Chat navigation on every web/Electron shell. */
export function ScheduleCenter({ client, onClose, onOpenBotChat, onNewSchedule, headerLeading }: {
  client: ChatAgentClient; onClose(): void; onOpenBotChat?: (chatId: string) => void | Promise<void>; onNewSchedule?: (trigger: HTMLButtonElement) => void; headerLeading?: ReactNode;
}) {
  const api = client.bots?.routines;
  const [data, setData] = useState<BotRoutineCenterResponse | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<BotRoutineCenterQuery>({});
  const currentQuery = useRef(query);
  const detailIntent = useRef(0);
  const selectedRoutine = useRef<string | null>(null);
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
  function acceptDetail(result: BotRoutineDetailResponse) {
    // An older read cannot replace a newer accepted control receipt.
    setDetail(current => current?.routine.routineId === result.routine.routineId && current.routine.revision > result.routine.revision ? current : result);
  }
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
      if (status === "archived" && detail?.routine.routineId === row.routineId) { detailIntent.current += 1; selectedRoutine.current = null; setDetail(null); setEditing(false); }
      else setDetail(current => current?.routine.routineId === row.routineId && current.routine.revision === row.revision
        ? { ...current, routine: { ...current.routine, status: result.status, revision: result.revision } } : current);
    },
  );
  function chooseFilter(next: BotRoutineCenterQuery) {
    currentQuery.current = next; reads.current += 1; detailIntent.current += 1; selectedRoutine.current = null;
    setDetail(null); setEditing(false); setData(null); setLoading(true); setQuery(next);
  }
  async function view(row: BotRoutineCenterItem) {
    if (!api) return;
    const intent = ++detailIntent.current, generation = lifetime.current;
    await act(async () => {
      const result = await api.detail(row.routineId);
      if (current.current === client && lifetime.current === generation && detailIntent.current === intent) { selectedRoutine.current = row.routineId; acceptDetail(result); setEditing(false); }
    });
  }
  async function refreshSelected() {
    if (!api) return;
    const selected = selectedRoutine.current, intent = detailIntent.current, generation = lifetime.current;
    await Promise.all([load(), selected ? api.detail(selected).then(result => {
      if (current.current === client && lifetime.current === generation && detailIntent.current === intent && selectedRoutine.current === selected) acceptDetail(result);
    }) : Promise.resolve()]);
  }
  const rowButtons = (row: BotRoutineCenterItem) => row.status !== "archived" ? <div className="flex flex-wrap gap-2">
    <button type="button" className={chatAgentButtonClass} disabled={pending || row.status === "paused" && (!row.sourceAvailable || row.requiresReview || !row.targetAvailable)}
      aria-label={`${row.status === "active" ? "Pause" : "Resume"} ${row.proposal.name}`}
      onClick={() => void control(row, row.status === "active" ? "paused" : "active")}>{row.status === "active" ? "Pause" : "Resume"}</button>
    <button type="button" className={chatAgentButtonClass} disabled={pending} aria-label={`Archive ${row.proposal.name}`} onClick={() => setArchiving(row)}>Archive</button>
  </div> : null;
  const ownerGeneration = lifetime.current;
  const refreshCommitted = () => {
    if (ownerGeneration !== lifetime.current || current.current !== client) return;
    void refreshSelected().catch((failure: unknown) => {
      console.warn("[schedules] Saved response refresh unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (ownerGeneration === lifetime.current) setError("Your response was saved. Schedules could not refresh. Try Refresh.");
    });
  };
  return <section aria-label="Schedules" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
      <div className="flex min-w-0 items-start gap-2">{headerLeading}<div><h1 className="text-lg font-semibold">Schedules</h1><p className="text-sm" style={chatAgentMutedStyle}>Your tasks on this Computer. Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p></div></div>
      <div className="flex flex-wrap gap-2">
        {onNewSchedule ? <button type="button" className={chatAgentButtonClass} disabled={pending} onClick={event => onNewSchedule(event.currentTarget)}>New schedule</button> : null}
        <button type="button" className={chatAgentButtonClass} aria-label="Close schedules" onClick={onClose}>Close</button>
      </div>
    </header>
    <div className="my-4 flex flex-wrap gap-2">
      <button type="button" className={chatAgentButtonClass} hidden={Boolean(detail)} aria-pressed={query.archived !== "true"} onClick={() => chooseFilter({})}>Current</button>
      <button type="button" className={chatAgentButtonClass} hidden={Boolean(detail)} aria-pressed={query.archived === "true"} onClick={() => chooseFilter({ archived: "true" })}>Archived</button>
      <button type="button" className={chatAgentButtonClass} disabled={pending || loading} onClick={() => void act(refreshSelected, undefined, false)}>Refresh</button>
    </div>
    {error ? <p role="alert" className="mb-3 text-sm">{error}</p> : null}
    {loading ? <p role="status">Loading schedules…</p> : null}
    {archiving ? <section role="dialog" aria-label="Archive schedule" className="mb-4 grid gap-3 rounded-xl border p-4">
      <h2 className="font-semibold">Archive {archiving.proposal.name}?</h2><p>No future runs will start. Any active run will be cancelled. History remains available.</p>
      <div className="flex flex-wrap gap-2"><button className={chatAgentButtonClass} type="button" disabled={pending} onClick={() => void control(archiving, "archived")}>Confirm archive</button>
        <button className={chatAgentButtonClass} type="button" disabled={pending} onClick={() => setArchiving(null)}>Keep schedule</button></div>
    </section> : null}
    {detail ? <section aria-label="Schedule details" className="mb-4 grid min-w-0 gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap justify-between gap-2"><h2 className="break-words font-semibold">{detail.routine.proposal.name}</h2><button type="button" className={chatAgentButtonClass} onClick={() => { detailIntent.current += 1; selectedRoutine.current = null; setDetail(null); setEditing(false); }}>Back to schedules</button></div>
      <p className="whitespace-pre-wrap break-words text-sm">{detail.routine.proposal.prompt}</p>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div><dt style={chatAgentMutedStyle}>Status</dt><dd>{statusLabel(detail.routine)}</dd></div>
        <div><dt style={chatAgentMutedStyle}>Next run</dt><dd className="break-words">{nextRun(detail.routine)}</dd></div>
        <div><dt style={chatAgentMutedStyle}>Schedule</dt><dd>{routineScheduleCopy(detail.routine.proposal.schedule).frequency}</dd><dd>{routineScheduleCopy(detail.routine.proposal.schedule).timezone}</dd></div>
        <div><dt style={chatAgentMutedStyle}>Runs in</dt><dd className="break-words">{names[detail.routine.botId] ?? "Private Bot"} · {detail.routine.computerId ?? "Computer unavailable"}</dd></div>
      </dl>
      {rowButtons(detail.routine)}
      <div className="flex flex-wrap gap-2">
        {onOpenBotChat ? <button className={chatAgentButtonClass} type="button" disabled={pending} onClick={() => void act(async () => { await onOpenBotChat(detail.routine.chatId); }, onClose, false)}>View history in Chat</button> : null}
        {detail.routine.status !== "archived" ? <button type="button" className={chatAgentButtonClass} disabled={pending || !detail.routine.targetAvailable || !detail.routine.sourceAvailable} onClick={() => setEditing(true)}>Edit schedule</button> : null}
      </div>
      {editing && api ? <ScheduleEditForm key={detail.routine.routineId} routine={detail.routine} api={api} botClient={client.bots!} agentName={names[detail.routine.botId]} pendingReadRevision={listRevision} getPendingReadSequence={() => reads.current} pendingInteractions={data?.pending ?? []} onRefreshRequired={refreshCommitted} onChanged={() => { detailIntent.current += 1; selectedRoutine.current = null; setEditing(false); setDetail(null); }}/>: null}
      <p className="text-sm" style={chatAgentMutedStyle}>Results and run history stay in this task’s Chat.</p>
    </section> : null}
    {data && !loading && !detail ? <>
      {!data.items.length ? <div className="rounded-xl border p-6"><h2 className="font-semibold">{query.archived === "true" ? "No archived schedules" : "No schedules yet"}</h2><p className="mt-2 text-sm" style={chatAgentMutedStyle}>Ask a private Bot Chat to schedule a task, then review and approve it in Chat.</p></div> : <ul className="grid min-w-0 gap-3">
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
