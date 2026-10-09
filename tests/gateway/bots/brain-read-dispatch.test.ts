import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotToolRequest } from "@matrix-os/contracts";
import { brainReadToolDefinitions, createBrainWhyToolHandler } from "@matrix-os/kernel";
import { createBrainAgentReadTools } from "../../../packages/gateway/src/brain/agent/index.js";
import { createBrainAgentTools } from "../../../packages/gateway/src/brain/api/index.js";
import { BotBrokerActionError, createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotBrainRead, type BotBrainServices } from "../../../packages/gateway/src/bots/brain-read.js";
import { BotRuntimeRegistry, type BotRuntimeBinding, type ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";

const OWNER = "user_owner_1";
const PROJECT = "proj_brain01";
const signal = new AbortController().signal;
const cite = {
  documentId: "doc_1", kind: "pr", label: "#12", title: "Keep bot chats out of project lists",
  permalink: "https://github.com/acme/app/pull/12", date: "2026-10-01T00:00:00Z",
};
const SEARCH_VIEW = {
  q: "bot chats", mode: "text", nextCursor: null, notices: [], freshness: { caughtUp: true, pendingDocuments: 0, pendingCapped: false },
  items: [{ type: "document", claim: null, cite, snippet: { text: "Bot chats are listed only under AGENTS", truncatedStart: false, truncatedEnd: false } }],
};
const WHY_PAGE = {
  path: "src/chat", match: "folder", total: 1, totalCapped: false, nextCursor: null,
  source: { webBase: "https://github.com/acme/app", lastSync: { status: "succeeded", finishedAt: "2026-10-07T10:00:00Z", nextAction: "none" } },
  items: [{
    kind: "pr", label: "#12", title: "Keep bot chats out of project lists", date: "2026-10-01T00:00:00Z", permalink: cite.permalink,
    link: "explicit", summary: { heading: "Summary", text: "Bot chats stay under AGENTS.", truncated: false }, invariants: null,
    specs: [], matchedPaths: ["src/chat"], matchedPathCount: 1,
  }],
};

function services(): BotBrainServices & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const record = <T>(name: string, value: T) => vi.fn(async (...args: unknown[]) => { calls.push([name, args]); return value; });
  return {
    calls,
    project: { why: record("why", WHY_PAGE), listClaims: record("claims", { kind: null, path: null, match: null, items: [], nextCursor: null }) } as never,
    search: { search: record("search", SEARCH_VIEW) } as never,
    graph: { timeline: record("timeline", { entity: { kind: "file", key: "a.ts", displayName: "a.ts" }, items: [], nextCursor: null, freshness: SEARCH_VIEW.freshness }) } as never,
    brief: {
      getBrief: record("brief", { date: "2026-10-08", window: "week", sections: { changes: [], decisions: [], commitments: [], risks: [], attention: [] }, summary: null, truncated: false }),
      conflicts: record("conflicts", { items: [], nextCursor: null }),
    } as never,
  };
}

const binding = (overrides: Partial<BotRuntimeBinding> = {}): BotRuntimeBinding => ({
  runtimeHandle: `runtime_${"b".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: "bot_0123456789abcdef", chatId: "chat_thread1",
  taskId: "task_brain1234", runId: "run_brain1", rootFingerprint: "f".repeat(64),
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
  accessSourceId: "matrix_included", capabilities: ["brain.read"], requestClass: "interactive", brainProjectId: PROJECT, ...overrides,
});
const request = (args: Record<string, unknown>) => ({ toolCallId: "call_brain1", capability: "brain.read", args }) as Extract<BotToolRequest, { capability: "brain.read" }>;

afterEach(() => { vi.unstubAllEnvs(); });

describe("brain.read in the bot broker", () => {
  it("answers with the kernel tool's own text for the thread's project and the run's owner", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_gateway_owner");
    const brain = services();
    const tools = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead(brain) });
    const { result } = await tools.dispatch(binding(), request({ tool: "search", input: { query: "bot chats" } }), signal);
    expect(brain.calls).toEqual([["search", [OWNER, PROJECT, expect.objectContaining({ q: "bot chats" })]]]);
    const kernel = brainReadToolDefinitions(createBrainAgentReadTools({ ownerId: OWNER, ...brain, impact: null })!)
      .find((definition) => definition.name === "brain_search")!;
    const expected = await kernel.handler({ query: "bot chats", project: PROJECT });
    expect(result).toEqual({ ok: true, content: expected.content });
    expect(expected.content[0]!.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(expected.content[0]!.text).toContain(cite.permalink);
    expect(tools.effectClass(request({ tool: "search", input: {} }))).toBe("read");
  });

  it("runs brain_why only in its brief form", async () => {
    const brain = services();
    const tools = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead(brain) });
    const { result } = await tools.dispatch(binding(), request({ tool: "why", input: { path: "src/chat/" } }), signal);
    expect(brain.calls).toEqual([["why", [OWNER, PROJECT, expect.objectContaining({ path: "src/chat/", detail: "brief" })]]]);
    const expected = await createBrainWhyToolHandler(createBrainAgentTools(brain.project, OWNER)!)({ project: PROJECT, path: "src/chat/", detail: "brief" });
    expect(result).toEqual({ ok: true, content: expected.content });
  });

  it("refuses another project in a thread and project or detail inside the input", async () => {
    const brain = services();
    const tools = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead(brain) });
    for (const args of [
      { tool: "search", project: "proj_other", input: { query: "x" } },
      { tool: "search", project: "matrix-os", input: { query: "x" } },
      { tool: "search", input: { query: "x", project: "proj_other" } },
      { tool: "why", input: { path: "src/", detail: "full" } },
      { tool: "why", input: { path: "" } },
      { tool: "search", input: { query: "x", owner: OWNER } },
      { tool: "brief", input: { window: "month" } },
    ]) {
      await expect(tools.dispatch(binding(), request(args), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    }
    await expect(tools.dispatch(binding(), request({ tool: "search", project: PROJECT, input: { query: "x" } }), signal)).resolves.toBeDefined();
    expect(brain.calls.map(([name]) => name)).toEqual(["search"]);
  });

  it("needs a named project in the bot's direct chat and passes it to the owner-scoped services", async () => {
    const brain = services();
    const tools = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead(brain) });
    const direct = binding({ brainProjectId: undefined, chatId: "chat_direct1" });
    await expect(tools.dispatch(direct, request({ tool: "conflicts", input: {} }), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await tools.dispatch(direct, request({ tool: "brief", project: "matrix-os", input: { window: "week" } }), signal);
    expect(brain.calls).toEqual([["brief", [OWNER, "matrix-os", { window: "week" }]]]);
  });

  it("is unavailable while the brain is off and when a view did not start", async () => {
    const off = createBotToolDispatcher({ homePath: "/tmp" });
    await expect(off.dispatch(binding(), request({ tool: "search", input: { query: "x" } }), signal)).rejects.toEqual(new BotBrokerActionError("unavailable"));
    const partial = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead({ ...services(), search: null }) });
    await expect(partial.dispatch(binding(), request({ tool: "search", input: { query: "x" } }), signal)).rejects.toEqual(new BotBrokerActionError("unavailable"));
  });

  it("is not granted to ordinary Matrix AI Chats", async () => {
    const tools = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead(services()), managedTools: { prepare: vi.fn(), dispatch: vi.fn() } as never });
    const { botId: _bot, taskId: _task, brainProjectId: _project, ...rest } = binding();
    const managed: ManagedPiRuntimeBinding = { ...rest, kind: "managed_chat", workspace: { kind: "chat_workspace" } };
    await expect(tools.prepare!(managed, request({ tool: "search", input: { query: "x" } }), signal)).rejects.toEqual(new BotBrokerActionError("not_granted"));
    await expect(tools.dispatch(managed, request({ tool: "search", input: { query: "x" } }), signal)).rejects.toEqual(new BotBrokerActionError("not_granted"));
  });

  it("refuses both brain reads and task hand-offs to a binding that holds both", async () => {
    const brain = services();
    const nativeTask = { prepare: vi.fn(), execute: vi.fn() };
    const tools = createBotToolDispatcher({ homePath: "/tmp", brainRead: createBotBrainRead(brain), nativeTask });
    const mixed = binding({ capabilities: ["brain.read", "agent.task"] });
    const task = { toolCallId: "call_task1", capability: "agent.task", args: { prompt: "Read the repo and push a fix." } } as BotToolRequest;
    for (const call of [request({ tool: "search", input: { query: "x" } }), task]) {
      await expect(tools.prepare!(mixed, call, signal)).rejects.toEqual(new BotBrokerActionError("denied"));
      await expect(tools.dispatch(mixed, call, signal)).rejects.toEqual(new BotBrokerActionError("denied"));
    }
    expect(nativeTask.prepare).not.toHaveBeenCalled();
    expect(nativeTask.execute).not.toHaveBeenCalled();
    expect(brain.calls).toEqual([]);
  });

  it("is denied to a run whose binding lacks the capability", async () => {
    const registry = new BotRuntimeRegistry();
    const bound = binding({ capabilities: ["artifact.read"] });
    registry.bind(bound);
    const dispatch = vi.fn();
    const actions = createBotBrokerActions({
      db: {} as never, registry, sessions: {} as never, checkpoints: {} as never,
      runs: { loadRunSpec: vi.fn(), readImageChunk: vi.fn() }, events: { publish: vi.fn() },
      tools: { effectClass: () => "read", dispatch }, inference: { homePath: "/tmp", lifetime: signal } as never,
    });
    await expect(actions.callTool(bound, request({ tool: "search", input: { query: "x" } }), signal)).rejects.toEqual(new BotBrokerActionError("denied"));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
