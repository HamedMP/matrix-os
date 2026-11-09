"use client";
import { useEffect, useRef, useState } from "react";
import {
  mergeUsageEvents,
  type UsageEvent,
} from "@matrix-os/contracts/ai-usage";
import { readUsageFiles } from "./read-files";
export function useUsageFiles(
  initialEvents: UsageEvent[],
  initialIssues: number,
) {
  const [events, setEvents] = useState(initialEvents),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [issues, setIssues] = useState(initialIssues),
    [sources, setSources] = useState(0);
  const generation = useRef<AbortController | null>(null);
  useEffect(() => () => generation.current?.abort(), []);
  async function selectFiles(files: File[]) {
    if (!files?.length) return;
    generation.current?.abort();
    const controller = new AbortController();
    generation.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await readUsageFiles(files, controller.signal);
      controller.signal.throwIfAborted();
      const merged = mergeUsageEvents([...events, ...result.events]);
      setEvents(merged.events);
      setIssues((value) => value + result.issues + merged.conflicts);
      setSources((value) => value + files.length);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        console.warn(
          "Usage files unavailable",
          cause instanceof Error ? cause.name : "UnknownError",
        );
        setError(
          "Could not read these files. Choose Claude/Codex JSONL or a Matrix usage export, up to 64 MB per file and 256 MB per selection.",
        );
      }
    } finally {
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- this is the operation finally block; stale generations must not clear a newer load
      if (generation.current === controller) setBusy(false);
    }
  }
  function clear() {
    try {
      generation.current?.abort();
      setEvents([]);
      setSources(0);
      setIssues(0);
      setError("");
    } finally {
      setBusy(false);
    }
  }

  return { events, busy, error, issues, sources, selectFiles, clear };
}
