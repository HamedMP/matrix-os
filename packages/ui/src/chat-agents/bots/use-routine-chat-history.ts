import { useEffect, useState } from "react";
import type { BotRoutineCenterQuery, BotRoutineCenterResponse, BotRoutineDetailResponse } from "@matrix-os/contracts";
import type { BotRoutineClient } from "./routine-client.js";

type Scope = {api: BotRoutineClient; chatId: string};
const message = "Scheduled task history could not be loaded. Refresh and try again.";

/** Bounded, read-only owner DTOs. Never show another Chat's schedules or occurrences. */
export function useRoutineChatHistory(api: BotRoutineClient, chatId: string, enabled: boolean) {
  const [query, setQuery] = useState<BotRoutineCenterQuery>({});
  const [tick, setTick] = useState(0), [selection, setSelected] = useState<(Scope & {id: string}) | null>(null);
  const [page, setPage] = useState<(Scope & {query: BotRoutineCenterQuery; value: BotRoutineCenterResponse}) | null>(null);
  const [detail, setDetail] = useState<(Scope & {id: string; value: BotRoutineDetailResponse}) | null>(null);
  const [error, setError] = useState<(Scope & {text: string}) | null>(null);
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const selected = selection?.api === api && selection.chatId === chatId ? selection.id : null;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setLoading(true); setError(null);
    void api.list(query).then(value => {
      if (current) setPage({api, chatId, query, value: {...value, items: value.items.filter(row => row.chatId === chatId), pending: []}});
    }).catch((failure: unknown) => {
      console.warn("[routine-history] List unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setError({api, chatId, text: message});
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, chatId, enabled, query, tick]);
  useEffect(() => {
    if (!enabled || !selected) return;
    let current = true;
    setDetailLoading(true); setDetail(null); setError(null);
    void api.detail(selected).then(value => {
      if (value.routine.chatId !== chatId || value.routine.routineId !== selected) throw new Error("History target changed");
      if (current) setDetail({api, chatId, id: selected, value});
    }).catch((failure: unknown) => {
      console.warn("[routine-history] Detail unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setError({api, chatId, text: message});
    }).finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [api, chatId, enabled, selected, tick]);
  const visible = page?.api === api && page.chatId === chatId && page.query === query ? page.value : null;
  const savedDetail = detail?.api === api && detail.chatId === chatId && detail.id === selected ? detail.value : null;
  function choose(next: BotRoutineCenterQuery) {setSelected(null); setDetail(null); setQuery(next);}
  return {
    items: visible?.items ?? [], detail: savedDetail,
    loading: enabled && loading, detailLoading: enabled && selected !== null && detailLoading,
    error: error?.api === api && error.chatId === chatId ? error.text : "",
    archived: query.archived === "true", nextCursor: visible?.nextCursor ?? null,
    showCurrent: () => choose({}), showArchived: () => choose({archived: "true"}),
    nextPage: () => { if (visible?.nextCursor) choose({...visible.nextCursor, ...(query.archived ? {archived: query.archived} : {})}); },
    select: (id: string) => {if (id === selected) return; setDetail(null); setSelected({api, chatId, id});}, refresh: () => setTick(value => value + 1),
  };
}
