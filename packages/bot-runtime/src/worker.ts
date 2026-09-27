import type { Agent } from "@earendil-works/pi-agent-core";
import { BotWorkerCommandSchema, type BotRunOutcome } from "@matrix-os/contracts";
import type { BotBrokerClient } from "./broker-client.js";
import { runBotTurn, type RunBotTurnInput } from "./loop.js";

export class BotWorkerError extends Error {
  constructor(readonly code: "busy" | "invalid_command") {
    super(`Bot worker refused the command: ${code}`);
    this.name = "BotWorkerError";
  }
}

export type BotWorkerReply = BotRunOutcome | { acknowledged: boolean };

/** One workload runs one bot turn at a time; steer and cancel target that run only. */
export function createBotWorker(deps: {
  broker: BotBrokerClient;
  bridgeOrigin: string;
  route?: RunBotTurnInput["route"];
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let active: { runId: string; controller: AbortController; agent?: Agent } | undefined;

  return {
    async handle(raw: unknown): Promise<BotWorkerReply> {
      const parsed = BotWorkerCommandSchema.safeParse(raw);
      if (!parsed.success) throw new BotWorkerError("invalid_command");
      const command = parsed.data;
      if (command.kind === "bot.run") {
        if (active) throw new BotWorkerError("busy");
        const run: { runId: string; controller: AbortController; agent?: Agent } = { runId: command.runId, controller: new AbortController() };
        active = run;
        try {
          return await runBotTurn({
            command,
            broker: deps.broker,
            bridgeOrigin: deps.bridgeOrigin,
            ...(deps.route ? { route: deps.route } : {}),
            signal: run.controller.signal,
            now,
            onAgent: (agent) => { run.agent = agent; },
          });
        } finally {
          active = undefined;
        }
      }
      if (!active || active.runId !== command.runId) return { acknowledged: false };
      if (command.kind === "bot.steer") {
        if (!active.agent) return { acknowledged: false };
        active.agent.steer({ role: "user", content: command.text, timestamp: now() });
        return { acknowledged: true };
      }
      active.controller.abort();
      return { acknowledged: true };
    },
    get activeRunId(): string | undefined {
      return active?.runId;
    },
  };
}
