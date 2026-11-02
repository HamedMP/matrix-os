import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { BotRoutineEditRequestSchema, type BotInteraction, type BotRoutineCenterItem, type BotRoutineSchedule } from "@matrix-os/contracts";
import type { BotRoutineClient } from "@matrix-os/ui/bot-routine-client";
import { routineScheduleCopy } from "@matrix-os/ui/bot-routine-presentation";
import { useRoutineReviewClosed } from "@matrix-os/ui/bot-routine-review";
import { Button, TextField } from "@/components/ui";
import { PendingInteraction } from "../interactions/PendingInteraction";
import type { ResolveSchedule } from "./SchedulesScreen";
import { scheduleStyles as styles } from "./styles";

/** Drafts survive current-revision refreshes; submitting creates a review, never a direct update. */
export function ScheduleEditor({ routine, api, resolve, actionsAvailable, pending, pendingRead, getReadSequence, onRefresh, onDone }: {
  routine: BotRoutineCenterItem; api: BotRoutineClient; resolve: ResolveSchedule; actionsAvailable: boolean;
  pending: readonly BotInteraction[]; pendingRead: number; getReadSequence(): number; onRefresh(): Promise<void>; onDone(): void;
}) {
  const opened = useRef(routine.revision), initial = routine.proposal.schedule;
  const [name, setName] = useState(routine.proposal.name), [prompt, setPrompt] = useState(routine.proposal.prompt);
  const [kind, setKind] = useState(initial.kind), [minutes, setMinutes] = useState(initial.kind === "interval" ? String(initial.everyMs / 60_000) : "60");
  const [at, setAt] = useState(initial.kind === "once" ? initial.at : ""), [cron, setCron] = useState(initial.kind === "cron" ? initial.expr : "0 9 * * *");
  const [timezone, setTimezone] = useState(initial.kind === "cron" ? initial.tz : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [review, setReview] = useState<BotInteraction | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false), mounted = useRef(true), readBarrier = useRef(0), decision = useRef<"approve" | "deny" | null>(null);
  const latestRead = useRef(pendingRead);
  useLayoutEffect(() => { latestRead.current = pendingRead; }, [pendingRead]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit() {
    if (!mounted.current || inFlight.current || !actionsAvailable) return;
    const schedule: BotRoutineSchedule = kind === "interval" ? { kind, everyMs: Number(minutes) * 60_000 }
      : kind === "once" ? {kind, at} : {kind, expr: cron, tz: timezone};
    const input = BotRoutineEditRequestSchema.safeParse({ baseRevision: routine.revision, name, prompt, schedule });
    if (!input.success) { setError("Check the task, time and timezone. Intervals must be at least one minute; a date needs its timezone offset."); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await api.review(routine.routineId, input.data);
      if (mounted.current) { readBarrier.current = Math.max(getReadSequence(), latestRead.current); decision.current = null; setReview(result.interaction); }
    } catch (failure: unknown) {
      console.warn("[mobile-schedules] Edit review unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (mounted.current) setError("Changes could not be submitted. Your draft is kept. Refresh before trying again.");
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const hasNewRead = review !== null && pendingRead > readBarrier.current;
  const currentReview = hasNewRead ? pending.find(item => item.interactionId === review!.interactionId) : review;
  const missing = hasNewRead && !currentReview;
  const closedReview = useRoutineReviewClosed(currentReview ?? review);
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.heading}>Review changes before they apply</Text>
    <Text style={styles.note}>The existing task keeps its settings until you approve. Pause it first if you do not want another run.</Text>
    {routine.revision !== opened.current ? <View style={styles.card}>
      <Text style={styles.note}>{`The saved schedule changed to revision ${routine.revision}. Your draft is kept. Check it before reviewing again.`}</Text>
      <Text style={styles.text}>{`Current saved task: ${routine.proposal.name} — ${routine.proposal.prompt}`}</Text>
      <Text style={styles.note}>{`Saved timing: ${routineScheduleCopy(routine.proposal.schedule).frequency}`}</Text>
    </View> : null}
    {review ? <>
      <PendingInteraction key={review.interactionId} interaction={currentReview ?? review} currentRoutineRevision={routine.revision}
        actionsAvailable={actionsAvailable && !missing} onResolve={async (_id, input) => {
          inFlight.current = true; setBusy(true);
          try { const result = await resolve(review, input); decision.current = input.kind === "approval" ? input.decision : null; return result; }
          catch (failure: unknown) { inFlight.current = false; if (mounted.current) setBusy(false); throw failure; }
        }} onRefresh={async () => {
          // A committed response must refresh even if the editor has since closed.
          try {
            await onRefresh();
            if (!mounted.current) return;
            if (decision.current === "deny") { setReview(null); setError(""); } else onDone();
          } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
        }} />
      {missing || closedReview ? <><Text style={styles.note}>The previous review is no longer available. Your draft is kept.</Text>
        <Button label="Return to draft" variant="outline" disabled={busy} onPress={() => { if (!inFlight.current) setReview(null); }} /></> : null}
    </> : <>
      <TextField accessibilityLabel="Task name" value={name} onChangeText={setName} maxLength={120} editable={!busy} />
      <TextInput accessibilityLabel="What should happen?" multiline value={prompt} onChangeText={setPrompt} maxLength={4096} editable={!busy} style={styles.input} />
      <View style={styles.row}>{([['interval', 'Every interval'], ['once', 'Once'], ['cron', 'Custom recurring time']] as const).map(([value, label]) =>
        <Button key={value} label={label} variant={value === kind ? "filled" : "outline"} disabled={busy} onPress={() => setKind(value)} />)}</View>
      {kind === "interval" ? <TextField accessibilityLabel="Interval in minutes" value={minutes} onChangeText={setMinutes} editable={!busy} maxLength={12} />
        : kind === "once" ? <TextField accessibilityLabel="Date and time including timezone offset" placeholder="2026-11-02T09:00:00+08:00" value={at} onChangeText={setAt} editable={!busy} maxLength={40} />
        : <><TextField accessibilityLabel="Cron expression" value={cron} onChangeText={setCron} editable={!busy} maxLength={128} />
          <TextField accessibilityLabel="Timezone" value={timezone} onChangeText={setTimezone} editable={!busy} maxLength={80} /></>}
      <Button label={routine.revision === opened.current ? "Review changes" : `Review against revision ${routine.revision}`} loading={busy} disabled={!actionsAvailable} onPress={() => void submit()} />
    </>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}
