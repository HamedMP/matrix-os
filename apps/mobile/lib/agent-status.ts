import {
  botInteractionCard,
  botTaskStatusCopy,
  type BotInteraction,
  type BotTaskSummary,
} from "@matrix-os/contracts";

// Mirrors packages/ui/src/chat-agents/bots/bot-rail-status.ts (derivation) and use-bot-rail-statuses.ts (fan-out).

export type AgentStatusState = "loading" | "unavailable" | "idle" | "working" | "attention" | "completed";

export interface AgentStatus {
  state: AgentStatusState;
  /** A short line for under the agent's name. */
  label: string;
}

/** A status together with what else the reads behind it happen to say. */
export interface AgentStatusEntry extends AgentStatus {
  /** The agent's own chat, when it has one and its status could be read. */
  chatId: string | null;
  /**
   * When the agent's most recent unfinished task last changed. Null once the
   * agent has no unfinished task: the status reads carry no other timestamp.
   */
  lastActivityAt: string | null;
}

export const AGENT_STATUS_LOADING: AgentStatus = { state: "loading", label: "Loading status…" };
export const AGENT_STATUS_UNAVAILABLE: AgentStatus = { state: "unavailable", label: "Status unavailable" };
export const AGENT_STATUS_IDLE: AgentStatus = { state: "idle", label: "No open tasks" };

export const AGENT_STATUS_ENTRY_LOADING: AgentStatusEntry = { ...AGENT_STATUS_LOADING, chatId: null, lastActivityAt: null };
export const AGENT_STATUS_ENTRY_UNAVAILABLE: AgentStatusEntry = {
  ...AGENT_STATUS_UNAVAILABLE, chatId: null, lastActivityAt: null,
};

/** Statuses are read for at most this many agents; the list route returns no more. */
export const MAX_AGENT_STATUSES = 100;
const MAX_READS_IN_FLIGHT = 4;

export function latestAgentTask(tasks: readonly BotTaskSummary[]): BotTaskSummary | undefined {
  // The contract accepts UTC timestamps both with and without milliseconds.
  return tasks.reduce<BotTaskSummary | undefined>((latest, candidate) => {
    const time = Date.parse(candidate.updatedAt);
    const latestTime = latest ? Date.parse(latest.updatedAt) : -Infinity;
    return !latest || time > latestTime || (time === latestTime && candidate.taskId > latest.taskId) ? candidate : latest;
  }, undefined);
}

export function agentLastActivityAt(tasks: readonly BotTaskSummary[]): string | null {
  return latestAgentTask(tasks)?.updatedAt ?? null;
}

/**
 * That an agent exists says nothing about what it is doing: only its tasks and
 * interactions do. A pending interaction outranks every task; with no
 * unfinished task and nothing pending the agent is idle.
 */
export function agentStatus(
  tasks: readonly BotTaskSummary[],
  interactions: readonly BotInteraction[],
  now: string,
): AgentStatus {
  const nowTime = Date.parse(now);
  const pending = interactions.find((item) => item.status === "pending" && Date.parse(item.expiresAt) > nowTime);
  if (pending) return { state: "attention", label: botInteractionCard(pending, now).title };
  const task = latestAgentTask(tasks);
  if (!task) return AGENT_STATUS_IDLE;
  const label = botTaskStatusCopy(task);
  switch (task.status) {
    case "running": return { state: "working", label };
    case "waiting_person": case "blocked": case "failed": return { state: "attention", label };
    case "completed": return { state: "completed", label };
    case "queued": case "waiting_capacity": case "cancelled": return { state: "idle", label };
  }
}

/** Whether this status means the agent is waiting on the person. */
export function agentNeedsUser(status: AgentStatus): boolean {
  return status.state === "attention";
}

export function countWaitingAgents(statuses: readonly AgentStatus[]): number {
  return statuses.filter(agentNeedsUser).length;
}

/** The three reads a template agent's status is derived from. */
export interface AgentStatusReads {
  directChat(agentId: string): Promise<string | null>;
  tasks(chatId: string): Promise<BotTaskSummary[]>;
  interactions(chatId: string): Promise<BotInteraction[]>;
}

/**
 * Runs at most `maxInFlight` pieces of work at once; the rest wait their turn.
 * Work that has not started when `signal` aborts is never started.
 */
function createLimiter(maxInFlight: number, signal?: AbortSignal) {
  let inFlight = 0;
  // Holds at most one entry per piece of work the caller has asked for.
  const waiting: (() => void)[] = [];
  return function limited<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (signal?.aborted) {
          reject(new Error("Agent status read was cancelled"));
          waiting.shift()?.();
          return;
        }
        inFlight += 1;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          inFlight -= 1;
          waiting.shift()?.();
        });
      };
      if (inFlight < maxInFlight) start();
      else waiting.push(start);
    });
  };
}

/**
 * Reads the status of every agent, never with more than four reads in flight.
 * One agent's failure makes that agent "unavailable" and no more; agents that
 * were not made from a template have no task or interaction reads at all and
 * are "unavailable" too. Rejects only when `signal` aborts.
 */
export async function readAgentStatuses(
  agents: readonly { id: string; recipeRef?: unknown }[],
  reads: AgentStatusReads,
  options: { now?: () => string; signal?: AbortSignal } = {},
): Promise<Record<string, AgentStatusEntry>> {
  const now = options.now ?? (() => new Date().toISOString());
  const limited = createLimiter(MAX_READS_IN_FLIGHT, options.signal);

  async function statusOf(agent: { id: string; recipeRef?: unknown }, index: number): Promise<AgentStatusEntry> {
    if (index >= MAX_AGENT_STATUSES || !agent.recipeRef) return AGENT_STATUS_ENTRY_UNAVAILABLE;
    try {
      const chatId = await limited(() => reads.directChat(agent.id));
      if (!chatId) return { ...AGENT_STATUS_IDLE, chatId: null, lastActivityAt: null };
      const [tasks, interactions] = await Promise.all([
        limited(() => reads.tasks(chatId)),
        limited(() => reads.interactions(chatId)),
      ]);
      const ownTasks = tasks.filter((task) => task.agentId === agent.id && task.chatId === chatId);
      const ownInteractions = interactions.filter((item) => item.agentId === agent.id && item.chatId === chatId);
      return {
        ...agentStatus(ownTasks, ownInteractions, now()),
        chatId,
        lastActivityAt: agentLastActivityAt(ownTasks),
      };
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      console.warn("[mobile] agent status unavailable", error instanceof Error ? error.name : "unknown");
      return AGENT_STATUS_ENTRY_UNAVAILABLE;
    }
  }

  const entries = await Promise.all(agents.map(async (agent, index) => [agent.id, await statusOf(agent, index)] as const));
  return Object.fromEntries(entries);
}
