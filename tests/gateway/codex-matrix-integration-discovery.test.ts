import { expect, it } from "vitest";
import { startCodexStartupRunner, waitForStartupText } from "../helpers/codex-startup-runner";
import { createCanonicalVoiceInstructions } from "../../packages/gateway/src/coding-agents/codex-matrix-integration-instructions.mjs";

const descriptor = (toolId: string, effect: "read" | "navigation" | "files" | "data") => ({
  toolId, effect, schemaRevision: "v1", description: toolId,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

it("describes only the frozen capabilities granted to a constrained canonical voice run", () => {
  const instructions = createCanonicalVoiceInstructions({
    executionPolicy: { revision: "v1", actionMode: "safe_reads", workspaceScope: "apps", tools: ["matrix_list_apps"], delegation: false },
    descriptors: [descriptor("matrix_list_apps", "read")],
  });
  expect(instructions).toContain("list installed Matrix apps");
  expect(instructions).not.toContain("open an installed Matrix app");
  expect(instructions).not.toContain("create a new note");
  expect(instructions).toContain("one or two short sentences");
  expect(instructions).toContain("Do not use Markdown or say tool names");
  expect(instructions).toContain("Gmail integrations are not desktop apps");
});

it("accurately describes the full canonical inventory without widening note or desktop authority", () => {
  const descriptors = [
    descriptor("matrix_list_apps", "read"), descriptor("matrix_inspect_app", "read"),
    descriptor("matrix_search_workspace", "read"), descriptor("matrix_open_app", "navigation"),
    descriptor("matrix_apply_app_files", "files"), descriptor("matrix_create_note", "data"),
    descriptor("matrix_list_notes", "read"), descriptor("matrix_edit_note", "data"), descriptor("matrix_close_app", "navigation"),
  ];
  const instructions = createCanonicalVoiceInstructions({
    executionPolicy: { revision: "v1", actionMode: "canonical_actions", workspaceScope: "apps", tools: descriptors.map(({ toolId }) => toolId), delegation: false },
    descriptors,
  });
  expect(instructions).toContain("list installed Matrix apps and open an installed Matrix app");
  expect(instructions).toContain("create, list, and safely edit notes");
  expect(instructions).toContain("close an installed app window");
  expect(instructions).toContain("inspect or search app files and apply an authorized app-file change");
  expect(instructions).toContain("cannot arbitrarily click desktop apps, control a browser, or send email");
  expect(instructions).toContain("Never bypass authority or approval requirements");
});

it.each([
  { method: "thread/start", providerThreadId: undefined },
  { method: "thread/resume", providerThreadId: "existing-provider-thread" },
])("gives Codex the safe Matrix integration fallback on $method", async ({ method, providerThreadId }) => {
  const runner = await startCodexStartupRunner({ failures: 0, providerThreadId });
  try {
    await waitForStartupText(runner.eventPath, "turn.completed");
    await runner.closed;
    const start = (await runner.requests()).find((request) => request.method === method);
    // Ordinary Chat keeps its existing read-only integration fallback rather
    // than receiving the canonical voice contract.
    expect(start?.developerInstructions).toContain("## Matrix OS orientation");
    expect(start?.developerInstructions).toContain("window.MatrixOS.db");
    expect(start?.developerInstructions).toContain("matrix-app-builder");
    expect(start?.developerInstructions).toContain("Only use tools present in this run");
    expect(start?.developerInstructions).not.toContain("mcp__matrix-os-ipc__manage_cron");
    expect(start?.developerInstructions).toContain("matrix-integrations inventory");
    expect(start?.developerInstructions).not.toContain("Default to one or two short sentences");
    expect(start?.developerInstructions).toContain("matrix-integrations describe");
    expect(start?.developerInstructions).toContain("matrix-integrations call");
    expect(start?.developerInstructions).toContain("exact action ID");
    expect(start?.developerInstructions).toContain("untrusted data");
    expect(start?.developerInstructions).toContain("account label");
    expect(start?.developerInstructions).toContain("read-only");
    expect(start?.developerInstructions).toContain("approval");
  } finally {
    await runner.close();
  }
});
