import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RoutineDestinationView } from "@matrix-os/contracts/routine-destination";
import type { ChatAgentClient } from "../chat-agents/client.js";

type Candidate = { botId: string; chatId: string; name: string };

/** Discovery and selection reuse existing direct Bot Chats; neither creates a Bot or binding. */
export function useRoutineDestinationPicker(client: ChatAgentClient | undefined, enabled: boolean) {
  const scope = useMemo(() => ({ client, enabled }), [client, enabled]);
  const current = useRef<typeof scope | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    current.current = scope; lifetime.current = controller;
    return () => { current.current = null; lifetime.current = null; controller.abort(); };
  }, [scope]);
  const [stored, setStored] = useState<{
    scope: typeof scope; view: RoutineDestinationView | null; candidates: Candidate[]; pending: boolean; error: string;
  } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (current.current !== scope || !lifetime.current) return;
    const sequence = ++generation.current;
    if (!scope.enabled || !scope.client?.bots?.routineDestination) return;
    const { client } = scope;
    setStored({ scope, view: null, candidates: [], pending: true, error: "" });
    try {
      const view = await client.bots!.routineDestination!.get(lifetime.current.signal);
      if (current.current !== scope || sequence !== generation.current) return;
      if (view.availability === "available") {
        setStored({ scope, view, candidates: [], pending: false, error: "" });
        return;
      }
      const library = await client.list();
      if (current.current !== scope || sequence !== generation.current) return;
      const candidates = await Promise.all(library.agents.filter(agent => !agent.archived && agent.recipeRef)
        .slice(0, 100).map(async agent => {
          const chatId = await client.bots!.directChat(agent.id);
          return chatId && await client.bots!.directBot(chatId) === agent.id
            ? { botId: agent.id, chatId, name: agent.name } : null;
        }));
      if (current.current === scope && sequence === generation.current) {
        setStored({ scope, view, candidates: candidates.filter(item => item !== null), pending: false, error: "" });
      }
    } catch (error: unknown) {
      console.warn("[routine-destination] Picker unavailable", error instanceof Error ? error.name : "UnknownError");
      if (current.current === scope && sequence === generation.current) {
        setStored({ scope, view: null, candidates: [], pending: false, error: "Routine destination could not be confirmed. Refresh and try again." });
      }
    }
  }, [scope]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- This is an operation epoch, not a DOM ref; cleanup invalidates outstanding reads.
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  const state = stored?.scope === scope ? stored : null;
  const choose = async (botId: string) => {
    if (!scope.enabled || !lifetime.current || !client?.bots?.routineDestination || !state?.view || state.pending || current.current !== scope) return;
    const target = state.candidates.find(item => item.botId === botId);
    if (!target) return;
    const sequence = ++generation.current;
    setStored({ ...state, pending: true, error: "" });
    try {
      const view = await client.bots.routineDestination.remember({ botId: target.botId, chatId: target.chatId, baseRevision: state.view.preference.revision }, lifetime.current.signal);
      if (current.current === scope && sequence === generation.current) setStored({ ...state, view, pending: false });
    } catch (error: unknown) {
      console.warn("[routine-destination] Selection unconfirmed", error instanceof Error ? error.name : "UnknownError");
      if (current.current === scope && sequence === generation.current) {
        setStored({ ...state, pending: false, view: null, error: "The destination change could not be confirmed. Refresh before trying again." });
      }
    }
  };
  return { view: state?.view ?? null, candidates: state?.candidates ?? [], pending: state?.pending ?? enabled, error: state?.error ?? "", choose, refresh };
}
