import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { isRoutineDirectBotId, type BotInteraction, type BotRoutineCenterItem, type BotRoutineCenterResponse, type BotRoutineDetailResponse, type ResolveBotInteractionRequest, type ResolveBotInteractionResponse } from "@matrix-os/contracts";
import type { BotRoutineClient } from "@matrix-os/ui/bot-routine-client";
import { routineTaskChat, routineScheduleCopy, routineStatusLabel as status, routineNextRun } from "@matrix-os/ui/bot-routine-presentation";
import { TabScreen } from "@/components/shell/TabScreen";
import { Button } from "@/components/ui";
import { ScheduleEditor } from "./ScheduleEditor";
import { scheduleStyles as styles } from "./styles";

export type ResolveSchedule = (interaction: BotInteraction, input: ResolveBotInteractionRequest) => Promise<ResolveBotInteractionResponse>;
const MAX_VISIBLE = 256;
const EMPTY: BotRoutineCenterResponse = { items: [], pending: [], nextCursor: null };
const date = (value: string) => new Date(value).toLocaleString();


/** Keyed by owner + Computer in the route; every read also has a view-generation fence. */
export function SchedulesScreen({ api, resolve, onBack, onOpenChat, onNewSchedule }: { api: BotRoutineClient; resolve: ResolveSchedule; onBack(): void; onOpenChat?: (chatId: string, botId?: string) => void | Promise<void>; onNewSchedule?: () => void }) {
  const [archived, setArchived] = useState(false), [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true), [fresh, setFresh] = useState(false), [error, setError] = useState("");
  const [detail, setDetail] = useState<BotRoutineDetailResponse | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [pendingRead, setPendingRead] = useState(0);
  const alive = useRef(true), listRead = useRef(0), detailIntent = useRef(0), selectedRef = useRef<string | null>(null);
  const mutation = useRef(false);
  const filter = useRef(archived), refreshRead = useRef(0), currentFresh = useRef(fresh);
  useLayoutEffect(() => { filter.current = archived; currentFresh.current = fresh; }, [archived, fresh]);
  const acceptDetail = (value: BotRoutineDetailResponse) => setDetail(current => current?.routine.routineId === value.routine.routineId
    && current.routine.revision > value.routine.revision ? current : value);
  const load = useCallback(async (cursor?: NonNullable<BotRoutineCenterResponse["nextCursor"]>) => {
    const read = ++listRead.current;
    setLoading(true);
    try {
      const result = await api.list({ archived: String(archived) as "true" | "false", ...cursor });
      if (!alive.current || read !== listRead.current) return false;
      setData(current => {
        const items = result.items.map(item => {
          const accepted = current.items.find(previous => previous.routineId === item.routineId);
          return accepted && accepted.revision > item.revision ? accepted : item;
        });
        return { ...result, items: cursor ? [...current.items, ...items.filter(item => !current.items.some(old => old.routineId === item.routineId))].slice(0, MAX_VISIBLE) : items };
      });
      setPendingRead(read); setFresh(true);
      return true;
    } catch (failure: unknown) {
      console.warn("[mobile-schedules] List unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current && read === listRead.current) { setFresh(false); setError("Schedules could not be refreshed. Try again."); }
      return false;
    } finally { if (alive.current && read === listRead.current) setLoading(false); }
  }, [api, archived]);
  const currentLoad = useRef(load);
  useLayoutEffect(() => { currentLoad.current = load; }, [load]);
  useEffect(() => {
    alive.current = true; setData(EMPTY); setFresh(false); setError("");
    selectedRef.current = null; setSelected(null); setDetail(null); setEditing(false); ++detailIntent.current;
    void load();
    return () => { alive.current = false; ++listRead.current; ++detailIntent.current; ++refreshRead.current; };
  }, [load]);
  async function view(id: string) {
    selectedRef.current = id; setSelected(id); setDetail(null); setEditing(false); setError("");
    const intent = ++detailIntent.current;
    try {
      const result = await api.detail(id);
      if (alive.current && intent === detailIntent.current && selectedRef.current === id) acceptDetail(result);
    } catch (failure: unknown) {
      console.warn("[mobile-schedules] Detail unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current && intent === detailIntent.current) setError("Schedule details could not be loaded. Refresh to try again.");
    }
  }
  function close() { ++detailIntent.current; selectedRef.current = null; setSelected(null); setDetail(null); setEditing(false); }
  async function refreshAll() {
    if (!alive.current) return;
    const refresh = ++refreshRead.current;
    const id = selectedRef.current, intent = detailIntent.current;
    const [listOk, detailOk] = await Promise.all([currentLoad.current(), (async () => {
      if (!id) return true;
      try {
        const result = await api.detail(id);
        if (alive.current && intent === detailIntent.current && selectedRef.current === id) acceptDetail(result);
        return true;
      } catch (failure: unknown) {
        console.warn("[mobile-schedules] Detail refresh unavailable", failure instanceof Error ? failure.name : "UnknownError");
        return false;
      }
    })()]);
    if (alive.current && refresh === refreshRead.current && intent === detailIntent.current && (!listOk || !detailOk)) {
      setFresh(false); setError("Status unavailable. Refresh before responding.");
    }
  }
  async function control(item: BotRoutineCenterItem, next: "active" | "paused" | "archived") {
    if (!alive.current || mutation.current || !currentFresh.current || archived !== filter.current) return;
    mutation.current = true; setBusy(true); setError("");
    try {
      const receipt = await api.control(item.routineId, { baseRevision: item.revision, status: next });
      if (!alive.current) return;
      ++listRead.current; ++detailIntent.current;
      const update = (value: BotRoutineCenterItem) => value.routineId === receipt.routineId && value.revision <= receipt.revision
        ? { ...value, revision: receipt.revision, status: receipt.status, nextFireAt: receipt.status === "active" ? value.nextFireAt : null } : value;
      setData(current => ({ ...current, items: current.items.map(update).filter(value => (value.status === "archived") === archived) }));
      setDetail(current => current ? { ...current, routine: update(current.routine) } : null);
      if (next === "archived") close();
      await refreshAll();
    } catch (failure: unknown) {
      console.warn("[mobile-schedules] Control unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) { setFresh(false); setError("The schedule could not be changed. Refresh its current revision before trying again."); }
    } finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  async function openHistory(chatId: string, botId?: string) {
    if (!onOpenChat || mutation.current || !alive.current) return;
    mutation.current = true; setBusy(true); setError("");
    try { await (botId ? onOpenChat(chatId, botId) : onOpenChat(chatId)); }
    catch (failure: unknown) {
      console.warn("[mobile-schedules] Chat unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError("This task’s Chat could not be opened. Try again.");
    } finally { mutation.current = false; if (alive.current) setBusy(false); }
  }
  const current = detail?.routine;
  const taskChat = current ? routineTaskChat(current) : null;
  return <TabScreen testID="schedules-screen"><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Button label="Back" variant="text" onPress={onBack} />
    <Text accessibilityRole="header" style={styles.title}>Schedules</Text>
    <Text style={styles.note}>Your tasks on the selected Computer. Review scheduled tasks in the Chat where they were requested.</Text>
    {onNewSchedule ? <Button label="New schedule" disabled={busy} onPress={onNewSchedule} /> : null}
    <View style={styles.row}><Button label={archived ? "Show current" : "Show archived"} variant="outline" disabled={busy} onPress={() => setArchived(value => !value)} />
      <Button label="Refresh" variant="outline" disabled={busy} onPress={() => { setError(""); void refreshAll(); }} /></View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {selected ? <>
      <Button label="Back to list" variant="text" onPress={close} />
      {!detail ? <Text style={styles.note}>Loading schedule…</Text> : current ? <View style={styles.group}>
        <Text accessibilityRole="header" style={styles.heading}>{current.proposal.name}</Text>
        <Text style={styles.text}>{current.proposal.prompt}</Text>
        <Text style={styles.note}>{`${status(current)} · Revision ${current.revision}`}</Text>
        <Text style={styles.note}>{`${isRoutineDirectBotId(current.botId) ? "Matrix Schedules" : `Bot: ${current.botId}`} · Computer: ${current.computerId ?? "Unavailable"}`}</Text>
        <Text style={styles.text}>{`${routineScheduleCopy(current.proposal.schedule).frequency} · ${routineScheduleCopy(current.proposal.schedule).timezone}`}</Text>
        <Text style={styles.note}>{`Next run: ${routineNextRun(current)}`}</Text>
        {current.status !== "archived" ? <View style={styles.row}>
          <Button label={current.status === "active" ? "Pause" : "Resume"} disabled={busy || !fresh || (current.status === "paused" && (!current.targetAvailable || !current.sourceAvailable || current.requiresReview))}
            onPress={() => void control(current, current.status === "active" ? "paused" : "active")} />
          <Button label="Edit" variant="outline" disabled={busy || !fresh || !current.targetAvailable || !current.sourceAvailable} onPress={() => setEditing(true)} />
          <Button label="Archive" variant="outline" disabled={busy || !fresh} onPress={() => Alert.alert(`Archive ${current.proposal.name}?`, "Stops future runs and requests cancellation of any active run. History remains available in Chat.", [
            {text: "Cancel", style: "cancel"}, {text: "Archive", style: "destructive", onPress: () => void control(current, "archived")},
          ])} />
        </View> : null}
        {taskChat && onOpenChat ? <Button label={taskChat.label} variant="text" disabled={busy} onPress={() => void openHistory(taskChat.chatId, current.originAvailable && current.originChatId === taskChat.chatId ? undefined : current.botId)} /> : null}
        {(current.originChatId || isRoutineDirectBotId(current.botId)) && !current.originAvailable ? <Text style={styles.note}>Source Chat unavailable.</Text> : null}
        {editing && current.status !== "archived" ? <ScheduleEditor key={current.routineId} routine={current} api={api} resolve={resolve}
          actionsAvailable={fresh && !busy} pending={data.pending} pendingRead={pendingRead} getReadSequence={() => listRead.current}
          onRefresh={refreshAll} onDone={() => { if (alive.current) setEditing(false); }} /> : null}
      </View> : null}
    </> : <>
      {loading ? <Text style={styles.note}>Loading schedules…</Text> : null}
      {!loading && fresh && !data.items.length ? <Text style={styles.note}>{archived ? "No archived schedules." : "No schedules yet. Ask in a private Chat to schedule a task, then review its proposal in that Chat."}</Text> : null}
      {data.items.map(item => <View key={item.routineId} style={styles.card}>
        <Button label={item.proposal.name} variant="text" onPress={() => void view(item.routineId)} />
        <Text style={styles.text}>{`${status(item)} · ${routineScheduleCopy(item.proposal.schedule).frequency}`}</Text>
        <Text style={styles.note}>{`${routineScheduleCopy(item.proposal.schedule).timezone} · ${isRoutineDirectBotId(item.botId) ? "Matrix Schedules" : `Bot ${item.botId}`} · ${item.computerId ?? "Computer unavailable"}`}</Text>
        <Text style={styles.note}>{`Next run: ${routineNextRun(item)}`}</Text>
        {item.lastFire ? <Text style={styles.note}>{`Last run: ${item.lastFire.status} · ${date(item.lastFire.scheduledFor)}`}</Text> : null}
      </View>)}
      {data.nextCursor && data.items.length < MAX_VISIBLE ? <Button label="Load more" disabled={loading} onPress={() => void load(data.nextCursor!)} /> : null}
    </>}
  </ScrollView></TabScreen>;
}
