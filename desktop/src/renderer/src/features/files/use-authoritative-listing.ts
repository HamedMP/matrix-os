import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import type { BrowserEntry } from "./browser-entries";

export type BrowserListingStatus = "loading" | "ready" | "error";

interface ListingScope {
  api: ApiClient | null;
  runtimeSlot: string;
  authGeneration: number;
  directory: string;
}

export function useAuthoritativeListing(options: ListingScope) {
  const { api, runtimeSlot, authGeneration, directory: currentDirectory } = options;
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [status, setStatus] = useState<BrowserListingStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<ListingScope>(() => ({
    api, runtimeSlot, authGeneration, directory: currentDirectory,
  }));
  const committedScopeRef = useRef<ListingScope>({
    api, runtimeSlot, authGeneration, directory: currentDirectory,
  });
  const requestGeneration = useRef(0);

  useLayoutEffect(() => {
    committedScopeRef.current = { api, runtimeSlot, authGeneration, directory: currentDirectory };
  }, [api, runtimeSlot, authGeneration, currentDirectory]);

  useLayoutEffect(() => {
    requestGeneration.current += 1;
  }, [api, runtimeSlot, authGeneration]);

  const run = useCallback(async (
    directory: string,
    fetchEntries: () => Promise<BrowserEntry[]>,
    surfaceStatus: boolean,
  ) => {
    if (!api) return [];
    const generation = ++requestGeneration.current;
    const requestScope = { api, runtimeSlot, authGeneration, directory };
    if (surfaceStatus) {
      setStatus("loading");
      setError(null);
    }
    try {
      const next = await fetchEntries();
      const connection = useConnection.getState();
      if (generation === requestGeneration.current
        && sameScope(committedScopeRef.current, requestScope)
        && connection.api === requestScope.api
        && connection.runtimeSlot === requestScope.runtimeSlot
        && connection.authGeneration === requestScope.authGeneration) {
        setEntries(next);
        setLoadedScope(requestScope);
        setStatus("ready");
        setError(null);
      }
      return next;
    } catch (caught: unknown) {
      if (surfaceStatus && generation === requestGeneration.current
        && sameScope(committedScopeRef.current, requestScope)) {
        setEntries([]);
        setLoadedScope(requestScope);
        setStatus("error");
        setError(toUserMessage(caught));
      }
      throw caught;
    }
  }, [api, runtimeSlot, authGeneration]);

  const invalidate = useCallback(() => {
    requestGeneration.current += 1;
  }, []);
  const scoped = api !== null && sameScope(loadedScope, {
    api, runtimeSlot, authGeneration, directory: currentDirectory,
  });
  return { entries, status, error, scoped, run, invalidate };
}

function sameScope(left: ListingScope, right: ListingScope): boolean {
  return left.api === right.api
    && left.runtimeSlot === right.runtimeSlot
    && left.authGeneration === right.authGeneration
    && left.directory === right.directory;
}
