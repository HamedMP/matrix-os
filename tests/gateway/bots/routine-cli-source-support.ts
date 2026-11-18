import type { RoutineCliOperation } from "../../../packages/contracts/src/bots/routine-cli.js";
import type { RoutineCliSourceContext } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { NOW, OWNER, at } from "./bot-state-support.js";
export const SOURCE_SCOPE = { ownerId: OWNER, computerId: "computer_one" };
export const invocation = (n: number) => `de000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const list: RoutineCliOperation = { operation: "list" };
export const control = { operation: "pause", routineId: `rt_${"a".repeat(24)}`, baseRevision: 1, requestId: invocation(99) } satisfies RoutineCliOperation;
export const context = (generation = "generation_one"): RoutineCliSourceContext => ({
  ...SOURCE_SCOPE, harness: "codex", generation, issuedAt: NOW, expiresAt: at(300_000), actions: ["read", "propose", "control"],
  identity: { kind: "chat_run", chatId: "chat_source", runId: "run_source", nativeTurnId: "turn_one", route: "native" },
});
