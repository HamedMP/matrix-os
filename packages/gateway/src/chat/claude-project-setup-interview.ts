import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { buildAgentRuntimeEnvironment, type AgentLaunchInput, type AgentLaunchSpec } from "../agent-launcher.js";
import { boundedOperation } from "../bounded-operation.js";
import type { KernelCredentialLaunch } from "../kernel-credentials.js";
import { createBoundedCliLines } from "./bounded-cli-lines.js";
import { claudeChatLaunchEnvironment } from "./claude-chat-launch.js";
import { CanonicalCliError, runCanonicalCli, type CanonicalCliSpawn } from "./cli-process.js";
import { validateProjectSetupInterviewInput } from "./project-setup-interview-context.js";
import { parseCanonicalProviderRunInput, type CanonicalProviderRunEvent, type CanonicalProviderRunInput } from "./provider-adapter.js";
import { redactAssistantCredentials } from "./safe-activity-projection.js";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const RUN_TIMEOUT_MS = 90_000;
const Frame = z.object({ type: z.string(), subtype: z.string().optional(), result: z.string().optional(), is_error: z.boolean().optional() });
const CredentialEnv = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "LANG", "LC_ALL", "TZ"] as const;

/** Fresh, text-only Claude process for the setup interview. Unknown flags fail closed. */
function buildClaudeSetupInterviewLaunch(input: Pick<AgentLaunchInput, "cwd" | "runtimeHome" | "model" | "modelOptions">): AgentLaunchSpec {
  const effort = input.modelOptions?.find(option => option.id === "effort")?.value;
  return {
    command: "claude",
    cwd: input.cwd,
    env: buildAgentRuntimeEnvironment(input.runtimeHome),
    args: [
      "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--restricted", "--safe-mode", "--tools", "", "--disallowedTools", "*",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}',
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--no-chrome", "--disable-slash-commands", "--no-session-persistence",
      ...(input.model ? ["--model", input.model] : []),
      ...(typeof effort === "string" ? ["--effort", effort] : []),
    ],
  };
}

export async function* runClaudeProjectSetupInterview(inputValue: CanonicalProviderRunInput, options: {
  homePath: string;
  spawnFn?: CanonicalCliSpawn;
  resolveCredentials(): Promise<KernelCredentialLaunch>;
}): AsyncGenerator<CanonicalProviderRunEvent> {
  const input = parseCanonicalProviderRunInput(inputValue);
  validateProjectSetupInterviewInput(input, "review");
  const credentials = await boundedOperation(options.resolveCredentials, 10_000, input.signal);
  input.signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), "matrix-setup-interview-"));
  let result: string | undefined;
  try {
    input.signal.throwIfAborted();
    const launch = buildClaudeSetupInterviewLaunch({ cwd, runtimeHome: options.homePath,
      model: input.selection.model, modelOptions: input.selection.options });
    const env = claudeChatLaunchEnvironment(launch, Object.fromEntries(CredentialEnv.map(key => [key, credentials.env?.[key]])));
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.CLAUDE_CODE_DISABLE_CRON = "1";
    const writeController = new AbortController();
    let markReady: (() => void) | undefined;
    const lines = createBoundedCliLines(MAX_STDOUT_BYTES, raw => {
      if (!raw.trim()) return;
      const frame = Frame.parse(JSON.parse(raw));
      markReady?.();
      if (frame.type !== "result") return;
      if (result !== undefined || frame.subtype !== "success" || frame.is_error === true
        || !frame.result?.trim() || Buffer.byteLength(frame.result) > MAX_RESULT_BYTES) throw new CanonicalCliError("invalid_output");
      result = redactAssistantCredentials(frame.result);
    });
    await runCanonicalCli({ ...launch, env, replaceEnv: true, spawnFn: options.spawnFn,
      signal: AbortSignal.any([input.signal, writeController.signal]), startupTimeoutMs: 30_000,
      timeoutMs: Math.min(RUN_TIMEOUT_MS, credentials.fundedRunTimeoutMs ?? RUN_TIMEOUT_MS),
      maxStdoutBytes: MAX_STDOUT_BYTES, onStdout: chunk => lines.push(chunk),
      onStart(write, end, _idle, startup) {
        markReady = () => startup.ready();
        const frame = { type: "user", session_id: "", message: { role: "user", content: input.prompt }, parent_tool_use_id: null };
        void write(`${JSON.stringify(frame)}\n`).then(end).catch((error: unknown) => {
          console.warn("[project-setup] Claude input failed", error instanceof Error ? error.name : "UnknownError");
          writeController.abort();
        });
      },
    });
    lines.finish();
    if (!result) throw new CanonicalCliError("invalid_output");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  for (let offset = 0; offset < result.length; offset += 4000) {
    yield { type: "assistant.delta", delta: result.slice(offset, offset + 4000) };
  }
  yield { type: "run.completed", outcome: "completed" };
}
