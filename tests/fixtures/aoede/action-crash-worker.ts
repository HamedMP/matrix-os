import { createCanonicalActionAuthority } from "../../../packages/gateway/src/chat/action-authority.js";
import { ActionRepository } from "../../../packages/gateway/src/chat/action-repository.js";
import { createCanonicalActionTools } from "../../../packages/gateway/src/chat/action-tools.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

const config = JSON.parse(Buffer.from(process.env.MATRIX_ACTION_CRASH_CONFIG ?? "", "base64url").toString("utf8")) as {
  url: string; schema: string; home: string; ownerId: string; chatId: string; runId: string; actionId: string; arguments: unknown;
};
const owner = { type: "personal" as const, ownerId: config.ownerId };
const policy = { revision: "actions_pg_v1", actionMode: "canonical_actions" as const, workspaceScope: "apps", tools: ["matrix_apply_app_files"], delegation: false };
const chat = new ChatRepository(new PostgresDialect({ pool: new Pool({ connectionString: config.url, max: 2, connectionTimeoutMillis: 5_000, options: `-c search_path=${config.schema} -c statement_timeout=10000` }) }));

try {
  const repository = new ActionRepository(chat.kysely);
  const realTool = createCanonicalActionTools({ homeForOwner: async () => config.home }).find((tool) => tool.toolId === policy.tools[0]);
  if (!realTool) throw new Error("canonical apply tool unavailable");
  const authority = createCanonicalActionAuthority({
    repository,
    tools: [{
      ...realTool,
      async execute(input) {
        const result = await realTool.execute(input);
        process.send?.({ type: "effect_committed" });
        // Deliberately never return the canonical result. The parent SIGKILLs this
        // process after observing the real bounded file effect.
        return new Promise<never>(() => undefined);
      },
    }],
    qualifyPolicy: async () => policy,
    onEvent: async (identity, event) => {
      if (event.type === "approval.requested") {
        await repository.decide({ ...identity, argumentDigest: event.argumentDigest, decision: "approve", clientRequestId: "req_pg_crash_approve" });
      }
    },
  });
  await authority.invoke({ owner, chatId: config.chatId, runId: config.runId, actionId: config.actionId, toolId: policy.tools[0], arguments: config.arguments, executionPolicy: policy, signal: new AbortController().signal });
} finally {
  await chat.kysely.destroy();
}
