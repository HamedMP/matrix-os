import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { createCodexModelCatalogSource } from "../../packages/gateway/src/chat/codex-model-catalog.js";

export const codexProvider: AgentProviderSummary = {
  id: "codex", kind: "codex", displayName: "Codex", availability: "available", installStatus: "installed",
  authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", setupActions: [],
};

type Attempt = { reply: (model: string | null) => void; close: () => void; kills: string[] };

/** Only app-server process I/O is fake; cache, invalidation, and exit fencing are production code. */
export function codexCatalogFixture(options: Partial<Parameters<typeof createCodexModelCatalogSource>[0]> = {}) {
  const attempts: Attempt[] = [];
  let autoReply: string | null | undefined = "model-a";
  let autoClose = true;
  const source = createCodexModelCatalogSource({
    executable: "/synthetic/codex", cwd: "/synthetic/home", maxAttempts: 1, timeoutMs: 50, terminateGraceMs: 2,
    ...options,
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      const attempt: Attempt = {
        reply: (model) => child.stdout.write(JSON.stringify({ id: 2,
          result: model === null ? {} : { data: [{ id: model, model, displayName: model, hidden: false, isDefault: true,
            defaultReasoningEffort: "low", supportedReasoningEfforts: [] }], nextCursor: null } }) + "\n"),
        close: () => { child.emit("close", 0); },
        kills: [],
      };
      attempts.push(attempt);
      Object.assign(child, { kill: (signal: string) => { attempt.kills.push(signal); if (autoClose) queueMicrotask(attempt.close); return true; } });
      child.stdin.on("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id?: number };
        if (request.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{}}\n'));
        if (request.id === 2 && autoReply !== undefined) queueMicrotask(() => attempt.reply(autoReply!));
      });
      return child as never;
    },
  });
  return {
    source,
    attempts,
    setModel: (value: string | null | undefined) => { autoReply = value; },
    setAutoClose: (value: boolean) => { autoClose = value; },
  };
}
