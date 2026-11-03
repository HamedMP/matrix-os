import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BotRoutineEditRequestSchema, type BotInteraction, type BotRoutineSchedule, type BotRoutineCenterItem } from "@matrix-os/contracts";
import type { BotRoutineClient } from "./routine-client.js";
import type { BotClient } from "./client.js";
import { routineScheduleCopy } from "./routine-presentation.js";
import { InteractionCard } from "./InteractionCard.js";
import { chatAgentButtonClass, chatAgentInputClass } from "../theme.js";

export function ScheduleEditForm({ routine, api, botClient, agentName, onChanged, pendingReadRevision = 0, pendingInteractions = [], getPendingReadSequence, onRefreshRequired }: {
  routine: BotRoutineCenterItem; api: BotRoutineClient; botClient: BotClient; agentName?: string; onChanged(): void; onRefreshRequired(): void; pendingReadRevision?: number; getPendingReadSequence?: () => number; pendingInteractions?: readonly BotInteraction[];
}) {
  const liveReadRevision = useRef(pendingReadRevision), reviewedAtRead = useRef(pendingReadRevision);
  useLayoutEffect(() => { liveReadRevision.current = pendingReadRevision; }, [pendingReadRevision]);
  const openedRevision = useRef(routine.revision);
  const [name, setName] = useState(routine.proposal.name);
  const [prompt, setPrompt] = useState(routine.proposal.prompt);
  const initial = routine.proposal.schedule;
  const [kind, setKind] = useState(initial.kind);
  const [minutes, setMinutes] = useState(initial.kind === "interval" ? String(initial.everyMs / 60_000) : "60");
  const [at, setAt] = useState(initial.kind === "once" ? initial.at : "");
  const [cron, setCron] = useState(initial.kind === "cron" ? initial.expr : "0 9 * * *");
  const [timezone, setTimezone] = useState(initial.kind === "cron" ? initial.tz : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [interaction, setInteraction] = useState<BotInteraction | null>(null);
  const decision = useRef<"approve" | "deny" | null>(null);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function review() {
    if (busy.current) return;
    const schedule: BotRoutineSchedule = kind === "interval" ? { kind, everyMs: Number(minutes) * 60_000 }
      : kind === "once" ? { kind, at } : { kind, expr: cron, tz: timezone };
    const input = BotRoutineEditRequestSchema.safeParse({ baseRevision: routine.revision, name, prompt, schedule });
    if (!input.success) { setError("Check the task, time and timezone. Use an interval of at least one minute or a valid future ISO date."); return; }
    busy.current = true; setPending(true); setError("");
    try {
      const receipt = await api.review(routine.routineId, input.data);
      if (mounted.current) { reviewedAtRead.current = getPendingReadSequence?.() ?? liveReadRevision.current; decision.current = null; setInteraction(receipt.interaction); }
    } catch (failure: unknown) {
      console.warn("[schedules] Edit review unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (mounted.current) setError("Changes could not be submitted. Your draft is kept. Refresh to check the current revision before retrying.");
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  const freshRead = interaction !== null && pendingReadRevision > reviewedAtRead.current;
  const readback = freshRead ? pendingInteractions.find(item => item.interactionId === interaction!.interactionId) : interaction;
  const reviewUnavailable = freshRead && !readback;
  const shownInteraction = readback ?? interaction;
  const inputClass = chatAgentInputClass;
  return <section aria-label="Edit schedule" className="grid min-w-0 gap-3 border-t pt-4">
    <h3 className="font-semibold">Review changes before they apply</h3>
    <p className="text-sm">The existing schedule keeps its current settings until you approve these changes. Pause it first if you do not want another run.</p>
    {routine.revision !== openedRevision.current ? <div role="status" className="rounded-lg border p-3 text-sm"><p>The saved schedule changed to revision {routine.revision}. Your draft is kept. Check the saved task before reviewing again.</p><p className="mt-2 whitespace-pre-wrap break-words">Current saved task: {routine.proposal.name} — {routine.proposal.prompt}</p><p className="break-words">Saved timing: {routineScheduleCopy(routine.proposal.schedule).frequency} · {routineScheduleCopy(routine.proposal.schedule).timezone}</p></div> : null}
    {interaction && shownInteraction ? <><InteractionCard key={shownInteraction.interactionId} interaction={shownInteraction} actionsAvailable={!reviewUnavailable} agentName={agentName} currentRoutineRevision={routine.revision}
      onResolve={async input => { const result = await botClient.resolve(routine.chatId, interaction.interactionId, input); decision.current = input.kind === "approval" ? input.decision : null; return result; }}
      onResolved={() => { onRefreshRequired(); if (!mounted.current) return; if (decision.current === "deny") { setInteraction(null); setError(""); } else onChanged(); }}/>
      {reviewUnavailable ? <div className="grid gap-2 text-sm"><p>The previous review is no longer available. Your draft is kept.</p><button className={chatAgentButtonClass} type="button" onClick={() => { setInteraction(null); setError(""); }}>Return to draft</button></div> : null}
    </> : <>
      <label className="grid gap-1 text-sm">Task name<input className={inputClass} value={name} maxLength={120} disabled={pending} onChange={event => setName(event.currentTarget.value)}/></label>
      <label className="grid gap-1 text-sm">What should happen?<textarea className={inputClass} value={prompt} maxLength={4096} rows={3} disabled={pending} onChange={event => setPrompt(event.currentTarget.value)}/></label>
      <label className="grid gap-1 text-sm">Repeat<select className={inputClass} value={kind} disabled={pending} onChange={event => setKind(event.currentTarget.value as BotRoutineSchedule["kind"])}><option value="interval">Every interval</option><option value="once">Once</option><option value="cron">Custom recurring time</option></select></label>
      {kind === "interval" ? <label className="grid gap-1 text-sm">Interval in minutes<input className={inputClass} type="number" min={1} max={44640} step="any" value={minutes} disabled={pending} onChange={event => setMinutes(event.currentTarget.value)}/></label>
        : kind === "once" ? <label className="grid gap-1 text-sm">Date and time, including timezone offset<input className={inputClass} placeholder="2026-11-02T09:00:00+08:00" value={at} disabled={pending} onChange={event => setAt(event.currentTarget.value)}/></label>
        : <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">Cron expression<input className={inputClass} value={cron} disabled={pending} onChange={event => setCron(event.currentTarget.value)}/></label><label className="grid gap-1 text-sm">Timezone<input className={inputClass} value={timezone} disabled={pending} onChange={event => setTimezone(event.currentTarget.value)}/></label></div>}
      <button type="button" className={chatAgentButtonClass} disabled={pending} onClick={() => void review()}>{pending ? "Preparing review…" : routine.revision !== openedRevision.current ? `Review against revision ${routine.revision}` : "Review changes"}</button>
    </>}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
  </section>;
}
