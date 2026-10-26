import {
  GET_STARTED_BOT_NAME_EXCLUDE_MAX,
  GetStartedBotNamesResponseSchema,
  getStartedFallbackBotNames,
  type GetStartedBot,
  type GetStartedBotNameSuggestion,
  type GetStartedBotNamesRequest,
  type GetStartedGoalId,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

// Spec 636, Part B: five suggested names from the surface's gateway, or the
// built-in names whenever suggestions fail, answer badly or take too long.

const SUGGESTION_TIMEOUT_MS = 12_000;

type SuggestBotNames = (request: GetStartedBotNamesRequest, signal: AbortSignal) => Promise<unknown>;

export interface BotNameRequest {
  goals: readonly GetStartedGoalId[];
  personality: GetStartedBot["personality"];
}

interface Suggestions {
  /** Null until the first names arrive. */
  names: GetStartedBotNameSuggestion[] | null;
  /** The newest names shown, capped, so a refresh asks the model for different ones. */
  shown: string[];
  /** The next page of built-in names, kept apart from `shown` so every built-in name appears before any repeats. */
  fallbackPage: number;
  loading: boolean;
}

function showing(previous: readonly string[], names: GetStartedBotNameSuggestion[], fallbackPage: number): Suggestions {
  return { names, shown: [...previous, ...names.map((item) => item.name)].slice(-GET_STARTED_BOT_NAME_EXCLUDE_MAX), fallbackPage, loading: false };
}

export function useBotNameSuggestions(suggest: SuggestBotNames | null, initial: BotNameRequest) {
  const [state, setState] = useState<Suggestions>(() => (suggest ? { names: null, shown: [], fallbackPage: 0, loading: true } : showing([], getStartedFallbackBotNames(0), 1)));
  const suggestRef = useRef(suggest);
  const initialRef = useRef(initial);
  const pending = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    suggestRef.current = suggest;
  }, [suggest]);

  const cancel = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current.controller.abort();
    pending.current = null;
  }, []);

  /** Only the newest request shows; a late or superseded answer is dropped. */
  const request = useCallback((params: BotNameRequest, shown: readonly string[], fallbackPage: number) => {
    cancel();
    const exclude = shown.slice(-GET_STARTED_BOT_NAME_EXCLUDE_MAX);
    const showFallback = () => setState(showing(exclude, getStartedFallbackBotNames(fallbackPage), fallbackPage + 1));
    const current = suggestRef.current;
    if (!current) {
      showFallback();
      return;
    }
    const controller = new AbortController();
    /** True only for the newest request, once; a late or superseded answer is dropped. */
    const claim = () => {
      if (pending.current?.controller !== controller) return false;
      clearTimeout(pending.current.timer);
      pending.current = null;
      return true;
    };
    const timer = setTimeout(() => {
      if (claim()) showFallback();
      controller.abort();
    }, SUGGESTION_TIMEOUT_MS);
    pending.current = { controller, timer };
    current({ goals: [...params.goals], personality: params.personality, exclude }, controller.signal).then((raw) => {
      if (!claim()) return;
      const parsed = GetStartedBotNamesResponseSchema.safeParse(raw);
      if (parsed.success) setState(showing(exclude, parsed.data.names, fallbackPage));
      else showFallback();
    }, (error: unknown) => {
      if (!controller.signal.aborted) console.warn("[get-started] Name suggestions unavailable:", error instanceof Error ? error.name : typeof error);
      if (claim()) showFallback();
    });
  }, [cancel]);

  useEffect(() => {
    if (suggestRef.current) request(initialRef.current, [], 0);
    return cancel;
  }, [request, cancel]);

  const refresh = useCallback((params: BotNameRequest) => {
    setState((previous) => ({ ...previous, loading: true }));
    request(params, state.shown, state.fallbackPage);
  }, [request, state.shown, state.fallbackPage]);

  return { names: state.names, loading: state.loading, refresh };
}
