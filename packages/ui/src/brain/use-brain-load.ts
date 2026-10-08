"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { brainShellError } from "./brain-client.js";
import type { BrainShellErrorState } from "./brain-types.js";

export type BrainLoad<T> =
  | { readonly status: "idle" } | { readonly status: "loading" } | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly error: BrainShellErrorState };

/** Items one list keeps in memory; "Load more" stops here. */
export const BRAIN_LIST_MAX_ITEMS = 500;

const IDLE: BrainLoad<never> = { status: "idle" };
const rest = (token: string): string => token.slice(token.indexOf(":") + 1);
const LOADING: BrainLoad<never> = { status: "loading" };

/**
 * Runs `load` whenever `key` changes or `reload` is called; a null key loads nothing. A result that arrives after a
 * newer request started is dropped, so a slow answer never overwrites a newer one. A new `ask` reloads the same key.
 * While a reload of the same key runs, the previous ready data stays on screen. `replace` sets the data of the request
 * it was created for (and drops that request's load if it is still running, as the replaced data is newer), and does
 * nothing once a newer request started.
 */
export function useBrainLoad<T>(load: () => Promise<T>, key: string | null, ask = 0) {
  // Every key change, ask and reload gets a new request number, so a token is never reused.
  const [request, setRequest] = useState({ key, ask, number: 0 });
  if (request.key !== key || request.ask !== ask) setRequest({ key, ask, number: request.number + 1 });
  const [settled, setSettled] = useState<{
    readonly token: string; readonly key: string; readonly value: BrainLoad<T>;
  } | null>(null);
  const token = key === null ? null : `${request.number}:${key}`;
  const start = useEffectEvent(load);
  // The token whose data `replace` set; that request's own load, if still running, must not overwrite it.
  const replaced = useRef<string | null>(null);
  useEffect(() => {
    if (token === null) return undefined;
    let current = true;
    const settle = (value: BrainLoad<T>) => {
      if (current && replaced.current !== token) setSettled({ token, key: rest(token), value });
    };
    start().then(
      (data) => settle({ status: "ready", data }),
      (error: unknown) => settle({ status: "error", error: brainShellError(error) }),
    );
    return () => { current = false; };
  }, [token]);
  const kept = settled !== null && (settled.token === token || (settled.key === key && settled.value.status === "ready"));
  const state: BrainLoad<T> = token === null ? IDLE : kept ? settled.value : LOADING;
  const reload = useCallback(() => setRequest((value) => ({ ...value, number: value.number + 1 })), []);
  // `replace` is often called after an awaited action; data meant for an older token must not overwrite a newer key.
  const liveToken = useRef(token);
  useLayoutEffect(() => { liveToken.current = token; }, [token]);
  const replace = useCallback((data: T) => {
    if (token === null || liveToken.current !== token) return;
    replaced.current = token;
    setSettled({ token, key: rest(token), value: { status: "ready", data } });
  }, [token]);
  return { state, reload, replace, token };
}

interface BrainPageView<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
interface BrainMore<P, T> {
  readonly from: P; readonly key: string; readonly items: readonly T[]; readonly nextCursor: string | null;
  readonly busy: boolean; readonly error: BrainShellErrorState | null;
}

/** The appended pages that still belong to the list on screen: the same first page, or with `keep` the same key. */
function liveMore<P, T>(more: BrainMore<P, T> | null, from: P | null, key: string | null, keep: boolean): BrainMore<P, T> | null {
  return more !== null && (more.from === from || (keep && more.key === key)) ? more : null;
}

/** Appended items to show: all of them, or with `idOf` only those the fresh first page does not have again. */
function keptItems<T>(extra: readonly T[], first: readonly T[], idOf: ((item: T) => string) | undefined): readonly T[] {
  if (idOf === undefined || extra.length === 0) return extra;
  const fresh = new Set(first.map(idOf));
  return extra.filter((item) => !fresh.has(idOf(item)));
}

/**
 * A cursor-paged list: the first page through useBrainLoad, then "Load more" pages appended, capped in memory. The
 * extra pages belong to the first page their cursor came from: a reload keeps them until its new first page lands,
 * then drops them, unless `idOf` names each item: then they stay through a reload of the same key, and an item the
 * fresh first page has again is shown once, from that page.
 */
export function useBrainPages<P extends BrainPageView<unknown>>(
  fetchPage: (cursor: string | undefined) => Promise<P>, key: string | null, ask = 0,
  idOf?: (item: P["items"][number]) => string,
) {
  type T = P["items"][number];
  const first = useBrainLoad(() => fetchPage(undefined), key, ask);
  const [more, setMore] = useState<BrainMore<P, T> | null>(null);
  const firstPage = first.state.status === "ready" ? first.state.data : null;
  const extra = liveMore(more, firstPage, key, idOf !== undefined);
  const items: readonly T[] = firstPage === null ? []
    : [...firstPage.items, ...keptItems(extra?.items ?? [], firstPage.items, idOf)];
  const cursor = extra === null ? firstPage?.nextCursor ?? null : extra.nextCursor;
  const nextCursor = items.length >= BRAIN_LIST_MAX_ITEMS ? null : cursor;
  const loadMore = () => {
    if (nextCursor === null || firstPage === null || key === null || extra?.busy === true) return;
    const from = firstPage;
    const loaded = extra?.items ?? [];
    setMore({ from, key, items: loaded, nextCursor, busy: true, error: null });
    fetchPage(nextCursor).then(
      (page) => setMore((previous) => previous?.from === from
        ? { from, key, items: [...loaded, ...page.items], nextCursor: page.nextCursor, busy: false, error: null }
        : previous),
      (error: unknown) => setMore((previous) => previous?.from === from
        ? { from, key, items: loaded, nextCursor, busy: false, error: brainShellError(error) }
        : previous),
    );
  };
  return {
    first, items, nextCursor, loadMore, loadingMore: extra?.busy === true, moreError: extra?.error ?? null,
  };
}

/** One user action at a time (sync, connect, rebuild...): which one is running, and the last failure. */
export function useBrainAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<BrainShellErrorState | null>(null);
  const run = useCallback(<T>(name: string, action: () => Promise<T>, onDone: (value: T) => void) => {
    setBusy(name);
    setError(null);
    action().then(
      (value) => { setBusy(null); onDone(value); },
      (failure: unknown) => { setBusy(null); setError(brainShellError(failure)); },
    );
  }, []);
  return { busy, error, run };
}
