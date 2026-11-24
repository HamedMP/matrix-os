import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { expect, vi } from "vitest";
import {
  BotCreationSnapshotSchema, CanonicalChatDetailResponseSchema, CanonicalChatRecordSchema,
  CanonicalChatTurnAdmissionResponseSchema, InstantiateBotResponseSchema, type BotCreationDraftPatch, type BotCreationSnapshot, type BotSetupQuestion,
} from "@matrix-os/contracts";
import { createBotAuthority } from "../../../packages/gateway/src/bots/authority.js";
import { createBotCreationSelectionValidator } from "../../../packages/gateway/src/bots/creation-selection.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotProcedureResolver } from "../../../packages/gateway/src/bots/custom-procedure.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotInstantiation, ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { createChatAgentRecipeResolver } from "../../../packages/gateway/src/chat/agent-recipe.js";
import { createChatAgentRoutes } from "../../../packages/gateway/src/chat/agent-routes.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatRoutes } from "../../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../../packages/gateway/src/chat/service.js";
import type { AgentDraft } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import { createChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { createCreationConversation, type CreationConversationClient } from "../../../packages/ui/src/chat-agents/creation-conversation.js";
import { saveAgentDraft, type AgentCreationAttempt } from "../../../packages/ui/src/chat-agents/save-agent-draft.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import type { createRealBotStateDatabase } from "./bot-state-support.js";

const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
const approvedRecipe = { skills: ["matrix-integrations"], integrations: [{ service: "slack" }], output: "An English summary for my private Chat." };
const supportPatch = {
  name: "Support educator", description: "Prepare private support and education briefs.",
  instructions: "Draft private support answers from the approved Slack source.", recipe: approvedRecipe,
};
const editedInstructions = "Explain the next learning step and return the English summary to my private Chat.";
type RouteFixture = { fixture: Awaited<ReturnType<typeof createRealBotStateDatabase>>; ownerId: string; homePath: string };
type DraftFixture = (snapshot: BotCreationSnapshot, prompt: string) => BotCreationDraftPatch | Promise<BotCreationDraftPatch>;

/** A fixed test principal uses real owner routes/storage with a synthetic provider response, funding receipt and local Skill. */
export async function createEng85AgentRoutes({ fixture, ownerId, homePath, draftPatch = () => supportPatch, ask }:
  RouteFixture & { draftPatch?: DraftFixture; ask?: (snapshot: BotCreationSnapshot, prompt: string) => Pick<BotSetupQuestion, "question" | "suggestedReplies"> | undefined }) {
  const repository = new ChatRepository(fixture.db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath, db: repository.kysely });
  await agents.bootstrap();
  const skillsRoot = join(homePath, "skills/matrix");
  await mkdir(join(skillsRoot, "integrations"), { recursive: true });
  await writeFile(join(skillsRoot, "integrations/SKILL.md"), "---\nname: matrix-integrations\ndescription: Read approved sources\nauthor: Matrix OS\n---\nUse only the owner's approved sources.\n");
  const customRecipes = createChatAgentRecipeResolver({ skillsRoot, services: [{ id: "slack", name: "Slack" }, { id: "gmail", name: "Gmail" }] });
  const recipes = createBotRecipeCatalog();
  const snapshot = makeAiProviderSnapshot();
  const getPrincipal = () => ({ userId: ownerId, source: "jwt" as const });
  const botChats = createCustomBotChats({ chats: repository, agents });
  const procedures = createBotProcedureResolver({ db: fixture.db, agents, recipes, customRecipes });
  const context = new ChatAgentContext({ agents, repository, recipes: customRecipes, botChats, enabled: () => true });
  const catalog = { getCatalog: async () => ({
    revision: "eng85_fixture", drivers: [{ kind: "matrix_pi" as const, displayName: "Matrix AI", adapterVersion: "1", capabilityClass: "system_agent" as const }],
    instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "eng85_fixture" })),
  }) };
  const adapter: CanonicalChatProviderAdapter = {
    driverKind: "matrix_pi", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async *start(input) {
      const draft = BotCreationSnapshotSchema.parse(input.context?.botCreation);
      const turn = { proposalId: "proposal_" + input.runId, sessionId: draft.sessionId, baseDraftRevision: draft.draftRevision };
      const question = ask?.(draft, input.prompt);
      if (question) yield { type: "bot.setup.question", ...turn, ...question };
      else yield { type: "bot.draft.proposed", ...turn, patch: await draftPatch(draft, input.prompt) };
      yield { type: "run.completed", outcome: "completed" };
    },
  };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, agentContext: context, adapters: new CanonicalChatProviderRegistry([adapter]) });
  const instantiation = createBotInstantiation({ db: fixture.db, agents, chats: repository, recipes, customRecipes,
    ensureWorkspace: id => ensureBotWorkspace(homePath, id),
    validateSelection: createBotCreationSelectionValidator({ available: () => true, providers: { getSnapshot: async () => snapshot } }) });
  const authority = createBotAuthority({ agents, recipes, transact: createBotStateTransactions(repository), resolveProcedure: procedures.resolve });
  const app = new Hono();
  app.route("/", createBotRoutes({ getPrincipal, recipes, instantiation, authority, botChats }));
  app.route("/", createChatAgentRoutes({ getPrincipal, enabled: () => true, agents, context, recipes: customRecipes, botRecipes: recipes, catalog, repository }));
  app.route("/", createCanonicalChatRoutes({ getPrincipal, service: createCanonicalChatService(repository, { orchestrator }) }));
  return { app, agents, repository, customRecipes, close: async () => { await orchestrator.close(); await agents.close(); } };
}

/** Exercise the client, real Chat Run/event, preview, explicit save/retry and owner readback before passing the actual binding to Slack. */
export async function createEng85AgentThroughSetup(input: RouteFixture) {
  const question = "Which source should the support educator use?";
  const suggestedReplies = ["Use approved Slack", "Use this Chat only"];
  const routes = await createEng85AgentRoutes({ ...input,
    ask: snapshot => snapshot.intent === "open" ? { question, suggestedReplies } : undefined, draftPatch: (snapshot, prompt) => {
    if (prompt.includes("unapproved account")) return { recipe: { ...approvedRecipe, integrations: [{ service: "slack", accountLabel: "Other owner" }] } };
    return snapshot.draft.name ? { instructions: editedInstructions } : supportPatch;
  } });
  try {
    const createOutcomes: string[] = [];
    const request = async (path: string, method: string, body?: unknown) => {
      const response = await routes.app.request(path, { method, headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw Object.assign(new Error("Gateway returned HTTP " + response.status), { status: response.status });
      const result = await response.json();
      if (method === "POST" && path === "/api/chat-agents/managed-custom") {
        createOutcomes.push(InstantiateBotResponseSchema.parse(result).operation);
        if (createOutcomes.length === 1) throw new TypeError("Simulated response loss after durable Create");
      }
      return result;
    };
    const setup: CreationConversationClient = {
      create: async body => CanonicalChatRecordSchema.parse(await request("/api/chats", "POST", body)),
      admitTurn: async (chat, body) => CanonicalChatTurnAdmissionResponseSchema.parse(await request("/api/chats/" + chat + "/turns", "POST", body)),
      detail: async chat => CanonicalChatDetailResponseSchema.parse(await request("/api/chats/" + chat + "?botCreationVersion=2", "GET")),
      cancelRun: (chat, run, clientRequestId) => request("/api/chats/" + chat + "/runs/" + run + "/cancel", "POST", { clientRequestId }),
    };
    const client = createChatAgentClient(request, setup);
    let draft: AgentDraft = { requestId: "req_journey_agent", name: "", description: "", instructions: "", selection };
    const preview = async (sessionId: string, prompt: string, outcome: "completed" | "failed" = "completed") => {
      const conversation = createCreationConversation({ client: setup, sessionId, isCurrent: () => true, onChange: () => {},
        onProposal: proposal => { draft = { ...draft, ...proposal.patch }; return true; } });
      try {
        const { requestId: _requestId, ...fields } = draft;
        const snapshot = BotCreationSnapshotSchema.parse({ sessionId, draftRevision: 1, seed: { kind: "scratch" },
          draft: fields, choices: { skills: ["matrix-integrations"], services: ["slack"] } });
        if (sessionId === "session_create") {
          expect(await conversation.open(snapshot, selection)).toBe(true);
          await vi.waitFor(async () => {
            await conversation.refresh();
            expect(conversation.state().question).toMatchObject({ question, suggestedReplies });
          }, { timeout: 5000 });
          expect((await client.list()).agents).toHaveLength(0);
          expect(await conversation.replyToQuestion(suggestedReplies[0], snapshot, selection)).toBe(true);
        } else {
          expect(await conversation.send(prompt, snapshot, selection)).toBe(true);
        }
        const runId = conversation.state().activeRunId;
        expect(runId).toBeTruthy();
        await vi.waitFor(async () => {
          await conversation.refresh();
          expect(conversation.state().activeRunId).toBeNull();
          expect(conversation.state().detail?.runs.find(run => run.id === runId)?.status).toBe(outcome);
        }, { timeout: 5000 });
      } finally { conversation.dispose(); }
    };
    await preview("session_denied", "Choose the unapproved account.", "failed");
    expect(draft.recipe).toBeUndefined();
    await preview("session_cancel", "Prepare a private English summary from approved Slack support conversations.");
    expect(draft).toMatchObject(supportPatch);
    expect((await client.list()).agents).toHaveLength(0);
    // The owner dismisses the preview. The next editor starts with an empty draft.
    draft = { name: "", description: "", instructions: "", requestId: "req_reopened_agent", selection };
    await preview("session_create", "Create a support educator using my approved Slack source.");
    const retained: { current: AgentCreationAttempt | null } = { current: null };
    await expect(saveAgentDraft(client, retained, draft, "new")).rejects.toThrow();
    const reopened = (await client.list()).agents;
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject(supportPatch);
    const { saved } = await saveAgentDraft(client, retained, draft, "new");
    expect(createOutcomes).toEqual(["created", "replayed"]);
    expect(saved.id).toBe(reopened[0]!.id);
    const chatId = await client.bots!.directChat(saved.id);
    if (!chatId) throw new Error("Created Agent has no owner-scoped direct Chat");
    expect(chatId).toBe(retained.current?.chatId);
    await preview("session_edit", "Edit the instructions to explain the next learning step.");
    expect(draft.instructions).toBe(editedInstructions);
    expect((await client.list()).agents[0]?.instructions).toBe(supportPatch.instructions);
    await saveAgentDraft(client, { current: null }, draft, saved);
    expect((await client.list()).agents).toEqual([expect.objectContaining({
      id: saved.id, revision: saved.revision + 1, instructions: editedInstructions, recipe: approvedRecipe,
    })]);
    expect((await client.bots!.authority(saved.id)).grants).toEqual([]);
    return { ...routes, ownerId: input.ownerId, agentId: saved.id, chatId };
  } catch (error: unknown) { await routes.close(); throw error; }
}
