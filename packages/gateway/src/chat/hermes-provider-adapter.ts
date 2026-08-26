import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import {
  createCanonicalCliEventQueue,
  runCanonicalCli,
  type CanonicalCliSpawn,
} from "./cli-process.js";

const HermesChatStateSchema = z.object({
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
}).strict();
const HermesUsageSchema = z.object({
  session_id: HermesChatStateSchema.shape.sessionId,
}).passthrough();

export type HermesChatState = z.infer<typeof HermesChatStateSchema>;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 96 * 1024;

function selection(value: string): { provider: string; model: string } {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("Unsupported Hermes model selection");
  }
  const provider = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).parse(value.slice(0, separator));
  const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/).parse(value.slice(separator + 1));
  return { provider, model };
}

async function createUsageFile() {
  const directory = await mkdtemp(join(tmpdir(), "matrix-hermes-run-"));
  return { directory, path: join(directory, "usage.json") };
}

async function readUsageFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function cleanupUsageFile(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

function outputChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 4_000) {
    const chunk = text.slice(index, index + 4_000);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

export function createHermesChatProviderAdapter(options: {
  homePath: string;
  spawnFn?: CanonicalCliSpawn;
  timeoutMs?: number;
  createUsageFile?: () => Promise<{ directory: string; path: string }>;
  readUsageFile?: (path: string) => Promise<unknown>;
  cleanupUsageFile?: (directory: string) => Promise<void>;
}): CanonicalChatProviderAdapter<HermesChatState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function* execute(
    inputValue: CanonicalProviderRunInput<HermesChatState>,
    resumeState?: HermesChatState,
  ): AsyncGenerator<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    if (input.permissionMode !== "full_access") {
      throw new Error("Unsupported Hermes permission mode");
    }
    if (input.interactionMode !== "default") {
      throw new Error("Unsupported Hermes interaction mode");
    }
    const selected = selection(input.selection.model);
    const usage = await (options.createUsageFile ?? createUsageFile)();
    const cleanup = options.cleanupUsageFile ?? cleanupUsageFile;
    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    let output = "";
    const args = [
      "-z", input.prompt,
      "--provider", selected.provider,
      "--model", selected.model,
      "--usage-file", usage.path,
      "--source", "tool",
      "--yolo",
      ...(resumeState ? ["--resume", resumeState.sessionId] : []),
    ];

    void (async () => {
      try {
        await runCanonicalCli({
          command: "hermes",
          args,
          cwd: input.executionRoot ?? options.homePath,
          env: buildAgentRuntimeEnvironment(options.homePath),
          signal: input.signal,
          timeoutMs,
          maxStdoutBytes: MAX_OUTPUT_BYTES,
          spawnFn: options.spawnFn,
          onStdout(chunk) {
            output += chunk.toString("utf8");
          },
        });
        for (const delta of outputChunks(output)) {
          queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
        }
        try {
          const usageReport = HermesUsageSchema.parse(
            await (options.readUsageFile ?? readUsageFile)(usage.path),
          );
          if (usageReport.session_id !== resumeState?.sessionId) {
            queue.push(CanonicalProviderRunEventSchema.parse({
              type: "state.updated",
              state: { sessionId: usageReport.session_id },
            }));
          }
        } catch {
          console.warn("[chat/hermes] Usage report unavailable");
        }
        queue.push(CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "completed" }));
      } catch {
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "run.completed",
          outcome: input.signal.aborted ? "aborted" : "failed",
          ...(input.signal.aborted ? {} : {
            error: {
              code: "run_failed",
              safeMessage: "Hermes could not complete this Run. Check its provider connection and retry.",
              retryable: true,
              recoveryActions: ["retry"],
            },
          }),
        }));
      } finally {
        try {
          await cleanup(usage.directory);
        } catch (error: unknown) {
          console.warn("[chat/hermes] Temporary usage cleanup failed:", error instanceof Error ? error.name : "UnknownError");
        }
        queue.finish();
      }
    })();

    yield* queue.values();
  }

  return {
    driverKind: "hermes",
    stateSchemaVersion: 1,
    parseState: (value) => HermesChatStateSchema.parse(value),
    serializeState: (value) => HermesChatStateSchema.parse(value),
    start: (input) => execute(input),
    resume: (input) => execute(input, HermesChatStateSchema.parse(input.resumeState)),
  };
}
