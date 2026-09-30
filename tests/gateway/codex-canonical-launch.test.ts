import { expect, it } from "vitest";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
const canonicalExecution = { executionPolicy: { revision: "r1", actionMode: "safe_reads" as const, workspaceScope: "owner", tools: ["matrix_list_apps"], delegation: false }, inventory: [{ toolId: "matrix_list_apps", schemaRevision: "v1", description: "List apps", effect: "read" as const, inputSchema: { type: "object", properties: {}, additionalProperties: false } }], identity: { owner: { type: "personal" as const, ownerId: "u1" }, chatId: "chat_1", runId: "run_1" } };
const launch = { agent: "codex" as const, cwd: "/tmp", prompt: "List apps", providerEventPath: "/tmp/events.jsonl", sandbox: { enabled: true, mode: "read-only" as const }, canonicalExecution };
it("encodes immutable server-only execution grant into the actual owned app-server runner launch", () => {
  const spec = buildAgentLaunch(launch);
  const encoded = JSON.parse(Buffer.from(spec.args.at(-1)!, "base64").toString("utf8"));
  expect(encoded.canonical).toEqual(canonicalExecution);
  canonicalExecution.executionPolicy.tools.push("exec_command");
  expect(encoded.canonical.executionPolicy.tools).toEqual(["matrix_list_apps"]);
  canonicalExecution.executionPolicy.tools.pop();
});
it("cannot route a constrained grant through Codex exec, native resume or another harness", () => {
  expect(() => buildAgentLaunch({ ...launch, providerEventPath: undefined })).toThrow();
  expect(() => buildAgentLaunch({ ...launch, providerThreadId: "old-thread" })).toThrow();
  expect(() => buildAgentLaunch({ ...launch, agent: "claude" })).toThrow();
  expect(() => buildAgentLaunch({ ...launch, canonicalExecution: { ...canonicalExecution, executionPolicy: { ...canonicalExecution.executionPolicy, delegation: true } } })).toThrow();
});
