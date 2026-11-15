import { expect, it } from "vitest";
import { parseClaudeRoutineCommand } from "../../../packages/gateway/src/chat/claude-routine-command.js";
it("accepts only literal fixed CLI argv and quoted bounded stdin, leaving parsing to the actual CLI", () => {
  expect(parseClaudeRoutineCommand("mos routines list --json")).toEqual({ args: ["list", "--json"] });
  expect(parseClaudeRoutineCommand("matrix routines propose --input - --request-id de000000-0000-4000-8000-000000000001 <<'MATRIX_ROUTINE_JSON'\n{\"prompt\":\"$HOME; harmless data\"}\nMATRIX_ROUTINE_JSON")).toEqual({ args: ["propose", "--input", "-", "--request-id", "de000000-0000-4000-8000-000000000001"], stdin: '{"prompt":"$HOME; harmless data"}' });
  for (const command of ["matrix routines list; id", "matrix routines list && id", "matrix routines $(id)", "matrix routines list > /tmp/file", "matrix routines list --gateway x", "matrix routines list\nid", "matrix routines list --json=1", "matrix routines list | cat"]) expect(() => parseClaudeRoutineCommand(command)).toThrow();
  expect(parseClaudeRoutineCommand("git status")).toBeNull();
});
it("full-access row/native hints do not establish human provenance, and known scope/mode ceilings remain restrictive", async () => {
  const { createChatRoutineSourceProducer } = await import("../../../packages/gateway/src/chat/routine-chat-source.js");
  const { routineActionPolicy } = await import("../../../packages/gateway/src/bots/routine-action-source-registry.js");
  const input = { owner: { type: "personal" as const, ownerId: "owner" }, chatId: "chat_source", runId: "run_source", turnId: "cturn_source", parts: [{ type: "text" as const, text: "Fixture" }], prompt: "Fixture", selection: { instanceId: "claude_code_default", model: "fixture" }, interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal };
  const producer = (changes: Partial<typeof input> = {}) => createChatRoutineSourceProducer({ input: { ...input, ...changes }, computerId: "computer", signal: input.signal, current: () => true, publish: () => {} });
  const ordinary = producer(); expect(routineActionPolicy(ordinary.producer.source, ordinary.producer.readPolicy(), "propose")).toBe("ask"); ordinary.narrowNativeMode("bypassPermissions"); expect(ordinary.producer.readPolicy().originCeiling).toBe("exact");
  ordinary.narrowNativeMode("plan"); ordinary.narrowNativeMode("bypassPermissions"); expect(routineActionPolicy(ordinary.producer.source, ordinary.producer.readPolicy(), "propose")).toBe("deny");
  for (const source of [producer({ interactionMode: "review" }), producer({ interactionMode: "plan" }), producer({ owner: { type: "organization", ownerId: "org" } } as never), producer({ sharedScopeId: "shared" } as never)]) expect(routineActionPolicy(source.producer.source, source.producer.readPolicy(), "control")).toBe("deny");
});
