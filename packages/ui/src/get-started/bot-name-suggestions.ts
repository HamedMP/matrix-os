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
  /** Names shown so far, newest last, so a refresh asks for different ones. */
  shown: string[];
  loading: boolean;
}

function showing(previous: readonly string[], names: GetStartedBotNameSuggestion[]): Suggestions {
  return { names, shown: [...previous, ...names.map((item) => item.name)].slice(-GET_STARTED_BOT_NAME_EXCLUDE_MAX), loading: false };
}

export function useBotNameSuggestions(suggest: SuggestBotNames | null, initial: BotNameRequest) {
  const [state, setState] = useState<Suggestions>(() => (suggest ? { names: null, shown: [], loading: true } : showing([], getStartedFallbackBotNames([]))));
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
  const request = useCallback((params: BotNameRequest, shown: readonly string[]) => {
    cancel();
    const exclude = shown.slice(-GET_STARTED_BOT_NAME_EXCLUDE_MAX);
    const fallback = () => getStartedFallbackBotNames(exclude);
    const current = suggestRef.current;
    if (!current) {
      setState(showing(exclude, fallback()));
      return;
    }
    const controller = new AbortController();
    const finish = (names: GetStartedBotNameSuggestion[]) => {
      if (pending.current?.controller !== controller) return;
      clearTimeout(pending.current.timer);
      pending.current = null;
      setState(showing(exclude, names));
    };
    const timer = setTimeout(() => {
      finish(fallback());
      controller.abort();
    }, SUGGESTION_TIMEOUT_MS);
    pending.current = { controller, timer };
    current({ goals: [...params.goals], personality: params.personality, exclude }, controller.signal).then((raw) => {
      const parsed = GetStartedBotNamesResponseSchema.safeParse(raw);
      finish(parsed.success ? parsed.data.names : fallback());
    }, (error: unknown) => {
      if (!controller.signal.aborted) console.warn("[get-started] Name suggestions unavailable:", error instanceof Error ? error.name : typeof error);
      finish(fallback());
    });
  }, [cancel]);

  useEffect(() => {
    if (suggestRef.current) request(initialRef.current, []);
    return cancel;
  }, [request, cancel]);

  const refresh = useCallback((params: BotNameRequest) => {
    setState((previous) => ({ ...previous, loading: true }));
    request(params, state.shown);
  }, [request, state.shown]);

  return { names: state.names, loading: state.loading, refresh };
}
