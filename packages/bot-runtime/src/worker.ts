import {
  BOT_IMAGE_CHUNK_CHARS,
  BOT_IMAGE_MAX_BASE64_CHARS,
  BotImageInputSchema,
  BotWorkerCommandSchema,
  type BotImageInput,
  type BotRunCommand,
  type BotRunOutcome,
  type BotRunSpec,
  type BotToolErrorCode,
} from "@matrix-os/contracts";
import { ScopeRuntimeBotCommandSchema } from "@matrix-os/scope-runtime";
import { BotBrokerError, type BotWorkerBrokerClient } from "./broker-client.js";
import { runBotTurn, type BotTurnControl, type RunBotTurnInput } from "./loop.js";

/** Enough chunk reads for the largest image, plus one for a short final chunk. */
const MAX_IMAGE_CHUNK_READS = Math.ceil(BOT_IMAGE_MAX_BASE64_CHARS / BOT_IMAGE_CHUNK_CHARS) + 1;

export class BotWorkerError extends Error {
  constructor(readonly code: "busy" | "invalid_command") {
    super(`Bot worker refused the command: ${code}`);
    this.name = "BotWorkerError";
  }
}

export type BotWorkerReply = BotRunOutcome | { acknowledged: boolean };

class BotRunInputError extends Error {
  constructor() {
    super("Bot run input is invalid");
    this.name = "BotRunInputError";
  }
}

/** Reads each image in bounded chunks; a chunk that disagrees with the first one fails the run. */
export async function loadRunImages(broker: BotWorkerBrokerClient, count: number): Promise<BotImageInput[]> {
  const images: BotImageInput[] = [];
  for (let index = 0; index < count; index += 1) {
    let data = "";
    let mimeType: BotImageInput["mimeType"] | undefined;
    let totalChars: number | undefined;
    for (let reads = 0; ; reads += 1) {
      if (reads >= MAX_IMAGE_CHUNK_READS) throw new BotRunInputError();
      const chunk = await broker.readImageChunk({ index, offset: data.length });
      if ((mimeType && chunk.mimeType !== mimeType) || (totalChars !== undefined && chunk.totalChars !== totalChars)) {
        throw new BotRunInputError();
      }
      mimeType = chunk.mimeType;
      totalChars = chunk.totalChars;
      data += chunk.data;
      if (data.length > totalChars) throw new BotRunInputError();
      if (data.length === totalChars) break;
    }
    const image = BotImageInputSchema.safeParse({ mimeType, data });
    if (!image.success) throw new BotRunInputError();
    images.push(image.data);
  }
  return images;
}

export function runCommandFromSpec(runId: string, spec: BotRunSpec, images: readonly BotImageInput[]): BotRunCommand {
  const turn = spec.turn.kind === "prompt"
    ? { kind: "prompt" as const, text: spec.turn.text, ...(images.length > 0 ? { images: [...images] } : {}) }
    : spec.turn;
  const command = BotWorkerCommandSchema.safeParse({
    version: 1,
    kind: "bot.run",
    runId,
    route: spec.route,
    systemPrompt: spec.systemPrompt,
    capabilities: spec.capabilities,
    limits: spec.limits,
    turn,
  });
  if (!command.success || command.data.kind !== "bot.run") throw new BotRunInputError();
  return command.data;
}

async function loadRunCommand(broker: BotWorkerBrokerClient, runId: string): Promise<BotRunCommand> {
  const spec = await broker.loadRun();
  const imageCount = spec.turn.kind === "prompt" ? spec.turn.imageCount ?? 0 : 0;
  return runCommandFromSpec(runId, spec, await loadRunImages(broker, imageCount));
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  control?: BotTurnControl;
  done?: Promise<unknown>;
}

/**
 * Handles relayed commands inside one bot workload. One turn runs at a time;
 * steer and cancel target that run only. The worker loads the run itself
 * from the broker, so relayed commands never carry prompt content.
 */
export function createBotWorker(deps: {
  brokerFor(runId: string): BotWorkerBrokerClient;
  bridgeOrigin: string;
  route?: RunBotTurnInput["route"];
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let active: ActiveRun | undefined;

  async function run(runState: ActiveRun): Promise<BotRunOutcome> {
    const broker = deps.brokerFor(runState.runId);
    let command: BotRunCommand;
    try {
      command = await loadRunCommand(broker, runState.runId);
    } catch (error: unknown) {
      const failureCode: BotToolErrorCode = error instanceof BotBrokerError ? error.code : "invalid_arguments";
      if (!(error instanceof BotBrokerError) && !(error instanceof BotRunInputError)) {
        console.warn("[bot-runtime] run load failed:", error instanceof Error ? error.name : "UnknownError");
      }
      return { runId: runState.runId, status: "failed", failureCode, toolActions: 0 };
    }
    return runBotTurn({
      command,
      broker,
      bridgeOrigin: deps.bridgeOrigin,
      ...(deps.route ? { route: deps.route } : {}),
      signal: runState.controller.signal,
      now,
      onControl: (control) => { runState.control = control; },
    });
  }

  return {
    async handle(raw: unknown): Promise<BotWorkerReply> {
      const parsed = ScopeRuntimeBotCommandSchema.safeParse(raw);
      if (!parsed.success) throw new BotWorkerError("invalid_command");
      const command = parsed.data;
      if (command.kind === "bot.run") {
        if (active) throw new BotWorkerError("busy");
        const runState: ActiveRun = { runId: command.runId, controller: new AbortController() };
        active = runState;
        const done = run(runState);
        runState.done = done;
        try {
          return await done;
        } finally {
          active = undefined;
        }
      }
      if (!active || active.runId !== command.runId) return { acknowledged: false };
      if (command.kind === "bot.steer") {
        // Refused once the turn has stopped taking input, so an acknowledged steer is never dropped.
        return { acknowledged: active.control?.steer(command.text) ?? false };
      }
      active.controller.abort();
      return { acknowledged: true };
    },
    /** Cancels the active run and waits for its outcome, so the session is saved before exit. */
    async shutdown(): Promise<void> {
      const current = active;
      if (!current) return;
      current.controller.abort();
      await current.done?.catch((error: unknown) => {
        console.warn("[bot-runtime] run ended with an error during shutdown:", error instanceof Error ? error.name : "UnknownError");
      });
    },
    get activeRunId(): string | undefined {
      return active?.runId;
    },
  };
}
