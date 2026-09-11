import { spawn } from "node:child_process";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type InventoryQueryFactory = (input: Parameters<typeof query>[0]) => Pick<Query, "supportedModels" | "close">;
const MAX_INVENTORY_OUTPUT_BYTES = 1024 * 1024;

/** Read CLI initialization metadata, never submit a user message or run tools. */
export async function readClaudeModelInventory(options: {
  executable: string;
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  queryFn?: InventoryQueryFactory;
}): Promise<unknown> {
  options.signal.throwIfAborted();
  const controller = new AbortController();
  let releaseInput!: () => void;
  const finished = new Promise<void>((resolve) => { releaseInput = resolve; });
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const fail = (error: Error) => {
    rejectAborted(error);
    controller.abort();
    releaseInput();
  };
  const abort = () => fail(new Error("Claude inventory read aborted"));
  options.signal.addEventListener("abort", abort, { once: true });
  async function* noUserInput(): AsyncGenerator<SDKUserMessage> { await finished; }
  let session: Pick<Query, "supportedModels" | "close"> | undefined;
  try {
    session = (options.queryFn ?? query)({
      prompt: noUserInput(),
      options: {
        pathToClaudeCodeExecutable: options.executable,
        cwd: options.cwd, env: options.env, abortController: controller,
        persistSession: false, tools: [], settingSources: [], strictMcpConfig: true,
        mcpServers: {}, permissionMode: "default", settings: { disableAllHooks: true },
        extraArgs: { "no-chrome": null },
        // Use the selected CLI on the same PATH as canonical Chat, not the SDK's
        // bundled CLI. Custom spawn also supports an executable resolved by PATH.
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] });
          // Bound the wire bytes before the SDK's readline/JSON buffering, not
          // only the projected inventory after parsing has already completed.
          let outputBytes = 0;
          const observe = (chunk: Buffer | string) => {
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes <= MAX_INVENTORY_OUTPUT_BYTES) return;
            fail(new Error("Claude inventory output limit exceeded"));
            child.stdout.destroy();
            child.stderr.destroy();
          };
          child.stdout.on("data", observe);
          child.stderr.on("data", observe);
          return child;
        },
      },
    });
    return await Promise.race([session.supportedModels(), aborted]);
  } finally {
    controller.abort();
    releaseInput();
    options.signal.removeEventListener("abort", abort);
    session?.close();
  }
}
