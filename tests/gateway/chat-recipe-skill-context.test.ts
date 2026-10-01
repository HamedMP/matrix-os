import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { Hono } from "hono";
import type { WSEvents } from "hono/ws";
import { CanonicalChatQueuedTurnSchema, CanonicalChatRunSchema, ChatRunContextSchema, ResolvedChatAgentRecipeSchema } from "@matrix-os/contracts";
import { contextPrompt } from "../../packages/gateway/src/chat/agent-context.js";
import { createChatAgentRecipeResolver } from "../../packages/gateway/src/chat/agent-recipe.js";

import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import { registerCanonicalChatEventWebSocketRoute } from "../../packages/gateway/src/chat/event-websocket-route.js";
import { projectChatRecipeSources } from "../../packages/gateway/src/chat/recipe-source-wire.js";

const selected = { skills: ["resource-skill"], integrations: [], output: "Build a useful product" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-recipe-resource-")));
  roots.push(root);
  const bundled = join(root, "bundled");
  const homePath = join(root, "home");
  await mkdir(bundled);
  await mkdir(homePath);
  return { root, bundled, homePath };
}
async function skill(path: string, body: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `---\nname: resource-skill\ndescription: Read lazy resource guidance.\nauthor: Matrix OS\n---\n${body}\n`);
}
function runContext(recipe: unknown) {
  return ChatRunContextSchema.parse({ version: 1, requestHash: "a".repeat(64), chats: [],
    agent: { id: "bot_12345678", revision: 1, name: "Product builder", instructions: "Build carefully.", recipe } });
}

describe("saved recipe lazy resource locations", () => {
  it("pins the validated bundled source through persistence and injects it without loading resources", async () => {
    const { bundled, homePath } = await fixture();
    const sourceFile = join(bundled, 'different "directory"', "SKILL.md");
    const body = "Read [the guide](references/layout.md) when needed.";
    await skill(sourceFile, body);
    await mkdir(join(bundled, 'different "directory"', "references"));
    await writeFile(join(bundled, 'different "directory"', "references/layout.md"), "Lazy detail remains outside the recipe.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, homePath, services: [] });
    const recipe = await resolver.resolve(selected);
    expect(recipe.skills[0]).toMatchObject({ sourceFile, instructions: body,
      sha256: createHash("sha256").update(body).digest("hex") });
    const persisted = runContext(JSON.parse(JSON.stringify(recipe)));
    const prompt = contextPrompt("Build from a separate project directory", persisted);
    expect(prompt).toContain(`Skill source file: ${JSON.stringify(sourceFile)}`);
    expect(prompt).toContain("Resolve relative resource links against this file's directory");
    expect(prompt).toContain("available authorized file-reading tools");
    expect(prompt).not.toContain("Lazy detail remains outside the recipe.");
    expect(JSON.stringify(await resolver.catalog())).not.toContain(sourceFile);
    await skill(sourceFile, "Future body.");
    await expect(resolver.revalidate(persisted.agent!.recipe!)).resolves.toBeUndefined();
    expect(contextPrompt("Build", persisted)).toContain(body);
  });

  it("uses the discovered owner directory instead of guessing the skill name or mirror path", async () => {
    const { bundled, homePath } = await fixture();
    const sourceFile = join(homePath, ".agents/skills/custom-folder/SKILL.md");
    await skill(sourceFile, "Read [details](details.md).");
    await mkdir(join(homePath, ".claude/skills"), { recursive: true });
    await symlink(join(homePath, ".agents/skills/custom-folder"), join(homePath, ".claude/skills/mirror"));
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, homePath, services: [] });
    expect((await resolver.resolve(selected)).skills[0]).toMatchObject({ sourceFile });
    expect(JSON.stringify(await resolver.catalog())).not.toContain(homePath);
  });

  it("retains the actual filename for legacy flat skills", async () => {
    const { bundled, homePath } = await fixture();
    const sourceFile = join(homePath, "agents/skills/custom-guide.md");
    await skill(sourceFile, "Read [legacy detail](legacy-detail.md).");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, homePath, services: [] });
    expect((await resolver.resolve(selected)).skills[0]).toMatchObject({ sourceFile });
  });

  it("keeps the existing 24KiB instruction limit independent of bounded source metadata", async () => {
    const { bundled } = await fixture();
    const sourceFile = join(bundled, "bounded", "SKILL.md");
    await skill(sourceFile, "x".repeat(24 * 1024));
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, services: [] });
    const recipe = await resolver.resolve(selected);
    expect(recipe.skills[0]?.instructions).toHaveLength(24 * 1024);
    expect(recipe.skills[0]?.sourceFile).toBe(sourceFile);
    for (const invalid of ["/" + "x".repeat(2048), "/skills/guide\nforged.md", "relative/guide.md", "/" + "ü".repeat(1100)]) {
      expect(ResolvedChatAgentRecipeSchema.safeParse({ ...recipe,
        skills: [{ ...recipe.skills[0], sourceFile: invalid }] }).success).toBe(false);
    }
    await skill(sourceFile, "x".repeat(24 * 1024 + 1));
    await expect(resolver.resolve(selected)).rejects.toMatchObject({ code: "recipe_unavailable" });
  });


  it("excludes a source pathname containing control characters from discovery", async () => {
    const { bundled } = await fixture();
    await skill(join(bundled, "forged\nlocation", "SKILL.md"), "Instructions.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, services: [] });
    expect((await resolver.catalog()).skills).toEqual([]);
    await expect(resolver.resolve(selected)).rejects.toMatchObject({ code: "recipe_unavailable" });
  });

  it("keeps legacy persisted snapshots usable without inventing a resource path", () => {
    const context = runContext({ ...selected, skills: [{ id: "resource-skill", name: "resource-skill",
      instructions: "Original pinned instructions.", sha256: "b".repeat(64) }] });
    const prompt = contextPrompt("Build", context);
    expect(prompt).toContain("Original pinned instructions.");
    expect(prompt).not.toContain("Skill source file:");
  });
});

// Freeze the released recipe field set; sharing today's schema would hide this regression.
const releasedRecipe = ResolvedChatAgentRecipeSchema.safeExtend({
  skills: z.array(ResolvedChatAgentRecipeSchema.shape.skills.element.omit({ sourceFile: true })).max(8),
});
const releasedContext = ChatRunContextSchema.safeExtend({
  agent: ChatRunContextSchema.shape.agent.unwrap().extend({ recipe: releasedRecipe.optional() }).optional(),
});
const releasedRun = CanonicalChatRunSchema.safeExtend({ context: releasedContext.optional() });
const releasedQueuedTurn = CanonicalChatQueuedTurnSchema.extend({ context: releasedContext.optional() });
const wireStamp = "2026-10-02T00:00:00.000Z";

async function wireFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-recipe-wire-")));
  roots.push(root);
  const skillDirectory = join(root, "actual-folder");
  await mkdir(skillDirectory);
  const sourceFile = join(skillDirectory, "SKILL.md");
  await writeFile(sourceFile, "---\nname: resource-skill\ndescription: Read linked guides.\nauthor: Matrix OS\n---\nRead [the checklist](checklist.md) as needed.\n");
  await writeFile(join(skillDirectory, "checklist.md"), "Resource is read lazily.");
  const resolver = createChatAgentRecipeResolver({ skillsRoot: root, services: [] });
  const recipe = await resolver.resolve({ skills: ["resource-skill"], integrations: [], output: "Useful app" });
  // This is the same gateway-owned context serialization used by durable run state.
  const context = ChatRunContextSchema.parse(JSON.parse(JSON.stringify({
    version: 1, requestHash: "a".repeat(64), chats: [],
    agent: { id: "bot_12345678", revision: 1, name: "Builder", instructions: "Build carefully.", recipe },
  })));
  const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
  const run = CanonicalChatRunSchema.parse({ id: "run_recipe", chatId: "chat_recipe", turnId: "cturn_recipe",
    attempt: 1, driverKind: "codex", instanceId: selection.instanceId, selection,
    interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0, context,
    capabilitySnapshot: { revision: "catalog_recipe", rootChat: true, attachments: [], resources: [], tools: [],
      approvals: true, userInput: true, resume: true, cancellation: true, worktrees: "optional",
      interactionModes: ["default"], permissionModes: ["supervised"] }, createdAt: wireStamp, updatedAt: wireStamp });
  const record = { chat: { id: run.chatId, ownerScope: { type: "personal", ownerId: "owner" }, title: "Recipe",
    lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: wireStamp, updatedAt: wireStamp } };
  const message = { id: "msg_recipe", chatId: run.chatId, seq: 1, role: "user", state: "committed",
    turnId: run.turnId, parts: [{ type: "text", text: "Build" }], createdAt: wireStamp };
  const turn = { id: run.turnId, chatId: run.chatId, clientRequestId: "req_recipe", baseMessageSeq: 0,
    inputMessageId: message.id, status: "accepted", createdAt: wireStamp, updatedAt: wireStamp };
  const queuedTurn = CanonicalChatQueuedTurnSchema.parse({ id: "qturn_recipe", chatId: run.chatId,
    clientRequestId: "req_queue", position: 1, parts: message.parts, selection,
    interactionMode: "default", permissionMode: "supervised", context, createdAt: wireStamp, updatedAt: wireStamp });
  const detail = { record, messages: [message], turns: [turn], runs: [run], activities: [], queuedTurns: [queuedTurn] };
  return { sourceFile, run, queuedTurn, detail, admission: { record, message, turn, run, admission: "accepted" },
    request: { clientRequestId: "req_recipe", baseRevision: 0, parts: message.parts, selection,
      interactionMode: "default", permissionMode: "supervised" } };
}
function assertServerLocation(value: Awaited<ReturnType<typeof wireFixture>>) {
  expect(value.run.context?.agent?.recipe?.skills[0]?.sourceFile).toBe(value.sourceFile);
  expect(contextPrompt("Build", value.run.context)).toContain(JSON.stringify(value.sourceFile));
}
function assertPublicRuns(value: { runs?: unknown[]; run?: unknown; queuedTurns?: unknown[]; queuedTurn?: unknown }) {
  if (value.run) expect(releasedRun.safeParse(value.run).success).toBe(true);
  for (const run of value.runs ?? []) expect(releasedRun.safeParse(run).success).toBe(true);
  if (value.queuedTurn) expect(releasedQueuedTurn.safeParse(value.queuedTurn).success).toBe(true);
  for (const queued of value.queuedTurns ?? []) expect(releasedQueuedTurn.safeParse(queued).success).toBe(true);
  expect(JSON.stringify(value)).not.toContain("sourceFile");
  expect(JSON.stringify(value)).not.toContain("matrix-recipe-wire-");
}

describe("server-only recipe source locations", () => {
  it("preserves sourceFile in user/tool JSON while projecting only recipe metadata", async () => {
    const value = await wireFixture();
    const payload = { sourceFile: "design-source.json", context: { agent: { recipe: {
      skills: [{ sourceFile: "user-skill-reference.json" }],
    } } }, content: { sourceFile: "tool-content.json" } };
    const text = JSON.stringify(payload);
    const messages = [{ ...value.detail.messages[0], parts: [
      { type: "text", text },
      { type: "tool_result", toolCallId: "tool_json", outcome: "success", text, truncated: false },
    ] }];
    const activities = [{ id: "activity_json", chatId: value.run.chatId, runId: value.run.id,
      type: "tool.output", toolCallId: "tool_json", text, truncated: false, occurredAt: wireStamp }];
    const detail = { ...value.detail, messages, activities };
    const app = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      service: { getDetail: async () => detail } as unknown as CanonicalChatRouteService });
    const response = await app.request("/api/chats/chat_recipe?messageVersion=2", {
      headers: { "x-matrix-chat-metadata": "1" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages[0].parts).toEqual(messages[0].parts);
    expect(body.activities[0].text).toBe(text);
    expect(JSON.parse(body.messages[0].parts[0].text)).toEqual(payload);
    expect(releasedRun.safeParse(body.runs[0]).success).toBe(true);
    expect(body.runs[0].context.agent.recipe.skills[0]).not.toHaveProperty("sourceFile");
    // Opaque JSON fields remain untouched even when their own shape resembles a recipe.
    const opaque = { ...detail, messages: [{ parts: [{ data: payload }] }], activities: [{ output: payload }] };
    const projected = projectChatRecipeSources(opaque);
    expect(projected.messages).toEqual(opaque.messages);
    expect(projected.activities).toEqual(opaque.activities);
    expect(projected.runs[0]!.context?.agent?.recipe?.skills[0]).not.toHaveProperty("sourceFile");
    assertServerLocation(value);
  });

  it.each(["0", "1"])("keeps strict released HTTP consumers compatible for metadata version %s", async metadata => {
    const value = await wireFixture();
    expect(releasedRun.safeParse(value.run).success).toBe(false);
    const app = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      service: { getDetail: async () => value.detail, admitTurn: async () => value.admission,
        enqueueQueuedTurn: async () => ({ queuedTurn: value.queuedTurn, queueDepth: 1 }),
        cancelRun: async () => ({ run: { ...value.run, status: "aborted", outcome: "aborted", startedAt: wireStamp, completedAt: wireStamp }, cancellation: "aborted" }),
      } as unknown as CanonicalChatRouteService });
    const headers = { "content-type": "application/json", "x-matrix-chat-metadata": metadata };
    const responses = [
      await app.request("/api/chats/chat_recipe", { headers }),
      await app.request("/api/chats/chat_recipe/turns", { method: "POST", headers, body: JSON.stringify(value.request) }),
      await app.request("/api/chats/chat_recipe/queued-turns", { method: "POST", headers, body: JSON.stringify(value.request) }),
      await app.request("/api/chats/chat_recipe/runs/run_recipe/cancel", { method: "POST", headers,
        body: JSON.stringify({ clientRequestId: "req_cancel" }) }),
    ];
    for (const response of responses) {
      expect(response.status).toBeLessThan(300);
      assertPublicRuns(await response.json());
    }
    assertServerLocation(value);
  });

  it.each(["0", "1"])("omits locations from accepted/running SSE content for metadata version %s", async metadata => {
    const value = await wireFixture();
    const running = CanonicalChatRunSchema.parse({ ...value.run, status: "running", startedAt: wireStamp });
    const app = new Hono();
    registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      stream: { open: async ({ sink }) => {
        for (const run of [value.run, running]) sink.send({ type: "chat.content",
          event: { cursor: 1, chatId: run.chatId, revision: 0, eventType: "run.activity", createdAt: wireStamp },
          content: { record: value.detail.record as never, runs: [run], queuedTurns: [value.queuedTurn] } });
        return { onClose() {}, touch() {} };
      } }, setIntervalFn: vi.fn(() => 1), clearIntervalFn: vi.fn() });
    const response = await app.request("/api/chats/events?messageVersion=2&inputVersion=1", {
      headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2", "x-matrix-chat-metadata": metadata },
    });
    const reader = response.body!.getReader();
    try {
      for (let index = 0; index < 2; index++) {
        const frame = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]!.trim());
        assertPublicRuns(frame.content);
      }
    } finally { await reader.cancel(); }
    assertServerLocation(value);
  });

  it("keeps accepted/status WS notifications metadata-only and refuses recipe-bearing content", async () => {
    const value = await wireFixture();
    let handlers!: WSEvents;
    const contentResults: boolean[] = [];
    const app = new Hono();
    registerCanonicalChatEventWebSocketRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      stream: { open: async ({ sink }) => {
        for (const eventType of ["turn.accepted", "run.activity"] as const) sink.send({ type: "chat.event",
          event: { cursor: 1, chatId: value.run.chatId, revision: 0, eventType, createdAt: wireStamp } });
        contentResults.push(sink.send({ type: "chat.content", event: { cursor: 1, chatId: value.run.chatId,
          revision: 0, eventType: "run.activity", createdAt: wireStamp }, content: value.detail as never }));
        return { onClose() {}, touch() {} };
      } }, upgradeWebSocket: ((factory: (context: unknown) => WSEvents) => (context: unknown) => {
        handlers = factory(context); return new Response();
      }) as never });
    await app.request("/ws/chats/events");
    const ws = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    await handlers.onOpen?.({} as never, ws as never);
    expect(contentResults).toEqual([false]);
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send.mock.calls.map(([body]) => JSON.parse(body).event.eventType)).toEqual(["turn.accepted", "run.activity"]);
    expect(JSON.stringify(ws.send.mock.calls)).not.toMatch(/sourceFile|matrix-recipe-wire/);
    assertServerLocation(value);
  });
});
