import type { BotInteraction, BotTaskSummary, ResolveBotInteractionRequest, ResolveBotInteractionResponse } from "@matrix-os/contracts";
import { createContext, useContext } from "react";
import { InteractionCard } from "./InteractionCard.js";
import { BotCurrentTaskStatus } from "./BotCurrentTaskStatus.js";

export interface BotMessageState {
  chatId: string;
  agentId: string;
  interactions: readonly BotInteraction[];
  interactionsFresh: boolean;
  tasks: readonly BotTaskSummary[];
  error: string;
  resolve: (interactionId: string, input: ResolveBotInteractionRequest) => Promise<ResolveBotInteractionResponse>;
  refresh: () => void;
}
export const BotMessageStateContext = createContext<BotMessageState | null>(null);

/** Bind only through persisted run identity, never a timestamp, name or last visible message. */
function selectBody(state: BotMessageState, runIds: readonly string[], unassigned: boolean) {
  const tasks = state.tasks.filter(task => task.chatId === state.chatId && task.agentId === state.agentId);
  const matches = (runId?: string) => unassigned ? !runId || !runIds.includes(runId) : !!runId && runIds.includes(runId);
  return {
    tasks: tasks.filter(task => matches(task.runId)),
    interactions: state.interactions.filter(interaction => interaction.chatId === state.chatId && interaction.agentId === state.agentId
      && interaction.status === "pending" && matches(tasks.find(task => task.taskId === interaction.taskId)?.runId)),
  };
}
function MessageBody({ runIds, requestIds = [], unassigned = false }: {
  runIds: readonly string[]; requestIds?: readonly string[]; unassigned?: boolean;
}) {
  const state = useContext(BotMessageStateContext);
  if (!state) return null;
  const body = selectBody(state, runIds, unassigned);
  // A native input can coexist with Bot permissions; suppress only the identical request.
  const interactions = body.interactions.filter(interaction => !requestIds.includes(interaction.interactionId));
  const error = state.error && (unassigned ? !state.tasks.some(task => task.runId && runIds.includes(task.runId))
    : body.tasks.length > 0);
  if (!interactions.length && !body.tasks.length && !error) return null;
  return <div data-bot-message-state className="grid min-w-0 gap-3 py-2">
    {interactions.map(interaction => <InteractionCard key={interaction.interactionId} interaction={interaction}
      actionsAvailable={state.interactionsFresh} onResolve={input => state.resolve(interaction.interactionId, input)} onResolved={state.refresh}/>)}
    <BotCurrentTaskStatus tasks={body.tasks}/>
    {error ? <p role="alert" className="text-xs">{state.error}</p> : null}
  </div>;
}
export function BotRunMessageBody(props: { runIds: readonly string[]; requestIds?: readonly string[] }) {
  return <MessageBody {...props}/>;
}
/** Older or truncated histories retain actionable requests in an explicit assistant transcript row. */
export function BotUnassignedMessageBody(props: { runIds: readonly string[]; requestIds?: readonly string[] }) {
  return <div data-agent-message-body="unassigned" className="min-w-0"><MessageBody {...props} unassigned/></div>;
}
