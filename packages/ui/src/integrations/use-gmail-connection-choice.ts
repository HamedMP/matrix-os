"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GmailConnectionMethod, GmailConnectionOptions } from "@matrix-os/contracts/integration-marketplace";

/** The caller supplies its authenticated transport; eligibility only comes from the server. */
export function useGmailConnectionChoice(loadOptions: () => Promise<GmailConnectionOptions>) {
  const [options, setOptions] = useState<GmailConnectionOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  const selection = useRef<((method: GmailConnectionMethod) => void) | null>(null);
  const retry = useCallback(async () => {
    const attempt = ++generation.current;
    setLoading(true);
    setError(false);
    setOptions(null);
    try {
      const result = await loadOptions();
      if (generation.current === attempt) setOptions(result);
    } catch (error: unknown) {
      console.warn("[integrations] Gmail connection options unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (generation.current === attempt) setError(true);
    } finally {
      if (generation.current === attempt) setLoading(false);
    }
  }, [loadOptions]);
  useEffect(() => {
    selection.current = null;
    setOpen(false);
    void retry();
    return () => { generation.current += 1; selection.current = null; };
  }, [retry]);
  return {
    open, options, loading, error, retry,
    cancel: () => { selection.current = null; setOpen(false); },
    request: (connect: (method: GmailConnectionMethod) => void) => {
      if (!loading && !error && options?.methods.length === 1 && options.methods[0] === "pipedream") {
        connect("pipedream");
      } else {
        selection.current = connect;
        setOpen(true);
      }
    },
    choose: (method: GmailConnectionMethod) => {
      if (loading || error || !options?.methods.includes(method)) return;
      const connect = selection.current;
      selection.current = null;
      setOpen(false);
      connect?.(method);
    },
  };
}
