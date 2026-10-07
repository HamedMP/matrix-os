import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { editionSourceActions } from "./source-actions";
import { useEditionCleanup } from "./use-cleanup";
import { browserEditionRuntime, type EditionRuntime } from "./runtime";
import { loadDeviceDownloads } from "./device-downloads";
import { EditionDownloads } from "./offline";
import { refreshActiveArticle, refreshDownloads } from "./download-sync";
import {
  parseMessage,
  parseMessages,
  parseCleanupRecovery,
  parseSources,
} from "./transport";
import type {
  EditionMessage,
  EditionSource,
  EditionView,
  EditionScope,
  MailAction,
  ReadingPatch,
} from "./types";
const FAILURE =
  "This action could not be completed. Your saved editions remain available. Try again.";
export function useEdition(
  filters: {
    view: EditionView;
    scope: EditionScope;
    query: string;
    sourceId: string;
  },
  injectedRuntime?: EditionRuntime,
) {
  const [query, setQuery] = useState(filters.query);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filters.query), 250);
    return () => clearTimeout(timer);
  }, [filters.query]);
  const runtime = useMemo(
    () => injectedRuntime ?? browserEditionRuntime(),
    [injectedRuntime],
  );
  const { bridge, preview } = runtime;
  const [sources, setSources] = useState<EditionSource[]>([]),
    [messages, setMessages] = useState<EditionMessage[]>([]),
    [active, setActive] = useState<EditionMessage | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [cursor, setCursor] = useState<string | undefined>();
  const device = useRef<Awaited<ReturnType<typeof loadDeviceDownloads>> | null>(
    null,
  );
  const cache = useRef<EditionDownloads | null>(null),
    generation = useRef(0),
    mutation = useRef(false),
    syncPolls = useRef(0),
    readRequest = useRef(0),
    activeId = useRef<string | null>(null);
  const [downloaded, setDownloaded] = useState<string[]>([]),
    [offline, setOffline] = useState(!runtime.online());
  const cleanup = useEditionCleanup({
    call,
    performAction,
    offline,
    preview,
    notice: setStatus,
  });
  const replace = useCallback((m: EditionMessage) => {
    setMessages((rows) => rows.map((row) => (row.id === m.id ? m : row)));
    setActive((current) => (current?.id === m.id ? m : current));
  }, []);
  const reload = useCallback(async () => {
    const current = ++generation.current,
      selected = activeId.current,
      selection = readRequest.current;
    setLoading(true);
    setError("");
    if (selected && runtime.online()) setActive(null);
    if (!bridge) {
      setLoading(false);
      return;
    }
    if (!preview && runtime.downloads) {
      try {
        const loaded = await loadDeviceDownloads(runtime.downloads);
        if (current !== generation.current) return;
        if (device.current && device.current.cache.scope !== loaded.cache.scope)
          await device.current.clear();
        if (
          !device.current ||
          device.current.cache.scope !== loaded.cache.scope
        ) {
          device.current = loaded;
          cache.current = loaded.cache;
          setDownloaded(loaded.cache.list().map((m) => m.id));
        }
      } catch (cause) {
        console.warn("Edition downloads unavailable");
      }
    }
    if (!runtime.online() && cache.current) {
      setSources(cache.current.sources());
      setMessages(cache.current.list());
      setDownloaded(cache.current.list().map((m) => m.id));
      setOffline(true);
      setLoading(false);
      return;
    }
    try {
      const sourceResult = parseSources(await bridge("sources", {}));
      if (current !== generation.current) return;
      setSources(sourceResult.sources);
      cache.current?.setSources(sourceResult.sources);
      if (cache.current)
        await refreshDownloads(
          cache.current,
          bridge,
          () => current === generation.current && runtime.online(),
        );
      if (current !== generation.current) return;
      await device.current?.save();
      if (current !== generation.current) return;
      setDownloaded(cache.current?.list().map((m) => m.id) ?? []);
      const pending = cache.current?.pending() ?? [];
      for (const patch of pending) {
        const confirmed = parseMessage(
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordered revision-CAS replay must persist each confirmed revision before dispatching the next queued update.
          await bridge("reading", patch as unknown as Record<string, unknown>),
        );
        if (current !== generation.current) return;
        cache.current?.acknowledge(patch, confirmed);
        await device.current?.save();
      }
      const result = parseMessages(
        await bridge("messages", {
          view: filters.view,
          scope: filters.scope,
          query,
          ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
        }),
      );
      if (current !== generation.current) return;
      setMessages(result.messages);
      setCursor(result.nextCursor);
      if (!preview) {
        const recovery = parseCleanupRecovery(
          await bridge("cleanup-recovery", {}),
        );
        if (current !== generation.current) return;
        cleanup.recover(recovery);
      }
      if (selected)
        await refreshActiveArticle(
          bridge,
          selected,
          () =>
            current === generation.current &&
            selection === readRequest.current &&
            selected === activeId.current,
          (message) => {
            setActive(message);
            if (!message) activeId.current = null;
          },
        );
      setOffline(false);
    } catch (cause) {
      if (current !== generation.current) return;
      console.warn("Edition library unavailable");
      setError(FAILURE);
      if (!runtime.online() && cache.current) {
        setSources(cache.current.sources());
        setDownloaded(cache.current.list().map((m) => m.id));
        setMessages(cache.current.list());
        setOffline(true);
      }
    } finally {
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- reset is already in finally and generation-fenced so an old request cannot stop a newer spinner.
      if (current === generation.current) setLoading(false);
    }
  }, [
    bridge,
    preview,
    filters.view,
    filters.scope,
    filters.sourceId,
    query,
    cleanup.recover,
    runtime,
  ]);
  useEffect(() => {
    const pending = sources.some(
      (source) => source.state === "pending" || source.state === "running",
    );
    if (!pending) {
      syncPolls.current = 0;
      return;
    }
    if (loading || offline || error || preview || syncPolls.current >= 20)
      return;
    const timer = setTimeout(() => {
      syncPolls.current++;
      void reload();
    }, 3000);
    return () => clearTimeout(timer);
  }, [sources, loading, offline, error, preview, reload]);
  useEffect(() => {
    void reload();
    const online = () => {
        setOffline(false);
        void reload();
      },
      off = () => setOffline(true);
    const reset = () => {
      generation.current++;
      cache.current?.clear();
      void device.current
        ?.clear()
        .catch(() => console.warn("Edition downloads could not be cleared"));
      device.current = null;
      cache.current = null;
      setMessages([]);
      setSources([]);
      setActive(null);
      activeId.current = null;
      setDownloaded([]);
      cleanup.reset();
      setError("Your reading session changed. Reopen Edition in Matrix.");
    };
    const unsubscribe = runtime.subscribe?.(online, off, reset);
    return () => {
      generation.current++;
      unsubscribe?.();
    };
  }, [reload, runtime, cleanup.reset]);
  useEffect(() => {
    device.current = null;
    cache.current = null;
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- trusted runtime/owner change must erase retained async state; it cannot be derived from the new runtime.
    setActive(null);
    activeId.current = null;
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- trusted runtime/owner change must erase retained async state; it cannot be derived from the new runtime.
    setMessages([]);
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- trusted runtime/owner change must erase retained async state; it cannot be derived from the new runtime.
    setSources([]);
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- trusted runtime/owner change must erase retained async state; it cannot be derived from the new runtime.
    setDownloaded([]);
    cleanup.reset();
  }, [runtime, cleanup.reset]);
  async function call(action: MailAction, payload: Record<string, unknown>) {
    const current = generation.current;
    if (!bridge) throw new Error("Edition connection unavailable");
    const result = await bridge(action, payload);
    if (current !== generation.current)
      throw new Error("Reading session changed");
    return result;
  }
  async function performAction<T>(
    operation: () => Promise<T>,
  ): Promise<T | null> {
    if (mutation.current) return null;
    mutation.current = true;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      return await operation();
    } catch (cause) {
      console.warn("Edition action failed");
      if (current === generation.current) setError(FAILURE);
      return null;
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function open(id: string) {
    if (mutation.current) return;
    const request = ++readRequest.current;
    const current = generation.current;
    activeId.current = id;
    setActive(null);
    setBusy(true);
    setError("");
    try {
      const m = offline
        ? cache.current?.read(id)
        : parseMessage(await call("message", { id }));
      if (!m || m.id !== id) throw new Error("Edition unavailable");
      if (
        current === generation.current &&
        request === readRequest.current &&
        activeId.current === id
      )
        setActive(m);
    } catch (cause) {
      console.warn("Edition article unavailable");
      if (
        current === generation.current &&
        request === readRequest.current &&
        activeId.current === id
      )
        setError(FAILURE);
    } finally {
      if (current === generation.current && request === readRequest.current)
        // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- reset is in finally and selection-fenced; an older article request must not stop the newer request spinner.
        setBusy(false);
    }
  }
  async function reading(values: Omit<ReadingPatch, "id" | "baseRevision">) {
    const target = active;
    if (!target) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () => {
      const patch = {
        id: target.id,
        baseRevision: target.readingRevision,
        ...values,
      };
      if (offline) {
        if (!cache.current?.read(target.id))
          throw new Error("Download unavailable");
        cache.current.queue(patch);
        const next = { ...target, ...values };
        cache.current.download(next);
        await device.current?.save();
        replace(next);
        setStatus(
          "Reading update saved on this device. It will be checked when you reconnect.",
        );
      } else {
        const confirmed = parseMessage(await call("reading", patch));
        if (cache.current?.read(confirmed.id))
          cache.current.download(confirmed);
        await device.current?.save();
        replace(confirmed);
      }
    });
  }
  async function correct(classification: "newsletter" | "other") {
    const target = active;
    if (!target || offline) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () =>
      replace(
        parseMessage(
          await call("correct", {
            id: target.id,
            baseRevision: target.revision,
            classification,
          }),
        ),
      ),
    );
  }
  async function download() {
    if (!active || !cache.current) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () => {
      cache.current!.download(active);
      await device.current?.save();
      setDownloaded(cache.current!.list().map((m) => m.id));
      setStatus(
        "Downloaded for offline reading. Device copies are cleared when your Matrix session changes.",
      );
    });
  }
  async function exportEdition() {
    const target = active;
    if (!target || offline) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () => {
      const raw = await call("export", { messageIds: [target.id] });
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof (raw as { content?: unknown }).content !== "string" ||
        (raw as { content: string }).content.length > 10 * 1024 * 1024
      )
        throw new Error("Export unavailable");
      await runtime.exportContent((raw as { content: string }).content);
    });
  }
  async function deleteEdition() {
    const target = active;
    if (!target || offline || preview) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () => {
      const result = await call("delete", {
        messageId: target.id,
        baseRevision: target.revision,
      });
      if (!(result as { deleted?: boolean })?.deleted)
        throw new Error("Deletion unconfirmed");
      cache.current?.remove(target.id);
      await device.current?.save();
      setMessages((rows) => rows.filter((m) => m.id !== target.id));
      setDownloaded((ids) => ids.filter((id) => id !== target.id));
      if (activeId.current === target.id) {
        setActive(null);
        activeId.current = null;
      }
      setStatus(
        "Retained email removed from your Matrix computer. The source email is unchanged.",
      );
    });
  }
  async function removeDownload() {
    if (!active || !cache.current) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () => {
      cache.current!.remove(active.id);
      await device.current?.save();
      setDownloaded((ids) => ids.filter((id) => id !== active.id));
      setStatus(
        "Device download removed. Your saved edition stays on your Matrix computer.",
      );
    });
  }
  async function loadMore() {
    if (!cursor) return;
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- performAction is an imperative async mutation coordinator, not a React setter; state updater callbacks below remain pure.
    await performAction(async () => {
      const result = parseMessages(
        await call("messages", {
          cursor,
          view: filters.view,
          scope: filters.scope,
          query,
          ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
        }),
      );
      setMessages((rows) =>
        [
          ...rows,
          ...result.messages.filter((m) => !rows.some((r) => r.id === m.id)),
        ].slice(0, 2000),
      );
      setCursor(result.nextCursor);
    });
  }
  return {
    preview,
    available: !!bridge,
    sources,
    messages,
    active,
    loading,
    busy,
    error,
    status,
    ...cleanup,
    offline,
    downloaded,
    canDownload: !!cache.current,
    cursor,
    reload,
    open,
    close: () => {
      activeId.current = null;
      setActive(null);
    },
    reading,
    correct,
    download,
    removeDownload,
    exportEdition,
    deleteEdition,
    ...editionSourceActions({
      call,
      performAction,
      offline,
      preview,
      reload,
      notice: setStatus,
      resetPolling: () => {
        syncPolls.current = 0;
      },
      purgeSource: async (id) => {
        cache.current?.setSources(
          cache.current.sources().filter((s) => s.id !== id),
        );
        setSources((rows) => rows.filter((s) => s.id !== id));
        setMessages((rows) => rows.filter((m) => m.sourceId !== id));
        if (active?.sourceId === id) {
          setActive(null);
          activeId.current = null;
        }
        setDownloaded(cache.current?.list().map((m) => m.id) ?? []);
        await device.current?.save();
      },
    }),
    loadMore,
    performAction,
    bridge,
  };
}
