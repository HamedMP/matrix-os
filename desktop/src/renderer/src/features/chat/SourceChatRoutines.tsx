import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  RoutineOriginApprovals, routineApprovalPlacement, routineFullAccessChatPresentationEligible, useRoutineOrigin, type ChatAgentClient,
} from "@matrix-os/ui";
import type { CanonicalChatSummary } from "@matrix-os/contracts";
import { routineOriginBrowserUrl } from "@matrix-os/ui/routine-origin";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { desktopRoutineConfirmationDestination } from "./routine-action-confirmation";
import { invoke } from "../../lib/operator";

async function openDesktopRoutineApproval(chatId: string, interactionId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = await desktopRoutineConfirmationDestination();
  const url = routineOriginBrowserUrl(target.connection.platformHost, target.computer.gatewayPath, chatId, interactionId);
  signal.throwIfAborted();
  if (!target.current()) throw new Error("Chat context changed");
  await invoke("shell:open-external", { url });
}

/** Place source approvals beside their turns. Native review still uses the owner browser. */
export function SourceChatRoutines({ client, chat, ordinary, revision, identity, turns, callbacks }: {
  client?: ChatAgentClient;
  chat: CanonicalChatSummary;
  ordinary: boolean;
  revision: number;
  identity?: unknown;
} & Pick<ComponentProps<typeof ConversationTranscript>, "turns" | "callbacks">) {
  const eligible = routineFullAccessChatPresentationEligible({ chat, ordinary, fresh: true });
  const scope = useMemo(() => ({ client, chatId: chat.id, eligible, identity }), [client, chat.id, eligible, identity]);
  const state = useRoutineOrigin({ client: client?.bots?.routineOrigin, chatId: chat.id, eligible, revision, identity: scope });
  const lifetime = useRef<{ scope: typeof scope; controller: AbortController } | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = { scope, controller };
    return () => {
      lifetime.current = null;
      controller.abort();
    };
  }, [scope]);
  const [notice, setNotice] = useState<{ scope: typeof scope; text: string } | null>(null);
  const open = async (interactionId: string) => {
    const session = lifetime.current;
    if (!eligible || !state.fresh || session?.scope !== scope ||
        !state.view?.pending.some(({ interaction }) => interaction.interactionId === interactionId)) return;
    const { signal } = session.controller;
    try {
      await openDesktopRoutineApproval(chat.id, interactionId, signal);
      if (!signal.aborted) setNotice({ scope, text: "Continue in your browser to review this scheduled task." });
    } catch (error: unknown) {
      console.warn("[routine-origin] Browser unavailable", error instanceof Error ? error.name : "UnknownError");
      if (!signal.aborted) setNotice({ scope, text: "The browser could not be opened. Try again." });
    }
  };
  const placement = routineApprovalPlacement(state.view, turns.map(turn => ({
    id: turn.id,
    anchorMessageId: turn.user?.id,
    boundary: Boolean(turn.user || turn.routineReceipt),
  })));
  const reviewInBrowser = (id: string) => void open(id);
  return <ConversationTranscript turns={turns} callbacks={callbacks}
    beforeTurns={<RoutineOriginApprovals state={state} items={placement.earlier} notices={false} earlier onReviewInBrowser={reviewInBrowser} />}
    renderAfterTurn={id => {
      const items = placement.after.get(id);
      return items ? <RoutineOriginApprovals state={state} items={items} notices={false} onReviewInBrowser={reviewInBrowser} /> : null;
    }}
    afterTurns={<>
      <RoutineOriginApprovals state={state} items={placement.currentChanges} onReviewInBrowser={reviewInBrowser} />
      {eligible && notice?.scope === scope ? <p role="status" className="text-xs">{notice.text}</p> : null}
    </>} />;
}
