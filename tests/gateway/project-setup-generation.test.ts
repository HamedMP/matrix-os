import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openProjectSetupWorkspace } from "../../packages/gateway/src/chat/project-setup-workspace.js";
import { registerCustomMcpGatewayRoutes } from "../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { adapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { appendProjectSetupTranscript } from "../../packages/gateway/src/chat/project-setup-transcript.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { SideChatRepository } from "../../packages/gateway/src/chat/side-chat-repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
import { applyProjectSetupInterview, beginProjectSetupInterview, initialProjectSetup, projectSetupInterviewPrompt, transitionProjectSetupInterview } from "../../packages/gateway/src/chat/project-setup-state.js";
import { generateProjectSetup, syncProjectSetupGeneration } from "../../packages/gateway/src/chat/project-setup-generation.js";
import { ProjectSetupService } from "../../packages/gateway/src/chat/project-setup-service.js";
import { createChatExecutionRootResolver, type ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { jsonb } from "../../packages/gateway/src/chat/records.js";

const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
const executionRootFingerprint = "a".repeat(64);

it("rejects image embeds in Agent-generated setup replies and file proposals", () => {
  const context = { project: { name: "Operations" }, skills: [], instructionFiles: [], mcpServices: [] };
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_images", "project_ops", "Store operations", "msg_setup"));
  const base = { reply: "Review the suggested project setup.", focus: "review", suggestions: [],
    answers: { guidance: "Confirm the handoff with the next lead." } };
  const image = "![Equipment diagram](https://assets.example.com/floor-plan.png)";
  for (const generated of [
    { ...base, reply: image, review: {} },
    { ...base, review: { guidance: '<PICTURE><img src="https://assets.example.com/floor-plan.png"></PICTURE>' } },
    { ...base, review: { skill: { name: "shift-handoff", description: "Store handoff", instructions: image } } },
  ]) {
    expect(() => applyProjectSetupInterview(draft, JSON.stringify(generated), context)).toThrow();
  }
});

it("keeps the selected Skill manifest intact and lets the user remove a Skill from review", () => {
  const context = { project: { name: "Operations" }, skills: [], instructionFiles: [], mcpServices: [] };
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_skills", "project_ops", "Store operations", "msg_setup"));
  const question = applyProjectSetupInterview(draft, JSON.stringify({
    reply: "Would you like to choose a skill for store handoffs?", focus: "skill", suggestions: [],
  }), context).draft;
  const selected = "---\nname: shift-handoff\ndescription: Store handoff\n---\n\nConfirm break coverage with the next lead.\n"
    + "\n![Equipment diagram](https://assets.example.com/floor-plan.png)\n";
  const staged = transitionProjectSetupInterview(question, { type: "stage_skill", content: selected }).draft;
  const diagnose = {
    reply: "Review your handoff skill.", focus: "review", suggestions: [],
    review: { skill: { name: "unwanted-skill", description: "Different skill", instructions: "Perform another action." } },
  };
  const review = applyProjectSetupInterview(staged, JSON.stringify(diagnose), context).draft;
  expect(review.proposals).toEqual([expect.objectContaining({ path: ".agents/skills/shift-handoff/SKILL.md", content: selected })]);
  const dropSkill = JSON.stringify({
    ...diagnose, reply: "We’ll proceed without a skill.", review: { skill: null },
  });
  const revised = applyProjectSetupInterview(review, dropSkill, context).draft;
  expect(revised.skill).toBeUndefined();
  expect(revised.proposals).toEqual([]);

  const partiallySaved = { ...review, proposals: review.proposals.map(file => ({ ...file, status: "saved" as const })) };
  expect(applyProjectSetupInterview(partiallySaved, dropSkill, context).draft.proposals).toEqual(partiallySaved.proposals);
});

it("keeps edited project guidance when the owner revises only the Skill", () => {
  const context = { project: { name: "Operations" }, skills: [], instructionFiles: [], mcpServices: [] };
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_guidance", "project_ops", "Store operations", "msg_setup"));
  const base = { reply: "Review the project setup.", focus: "review", suggestions: [] };
  const first = applyProjectSetupInterview(draft, JSON.stringify({
    ...base, answers: { guidance: "Ask before publishing." }, review: { guidance: "# Initial guidance" },
  }), context).draft;
  const edited = transitionProjectSetupInterview(first, {
    type: "review_file", path: "AGENTS.md", content: "# Keep the handoff notes private.",
  }).draft;
  const revised = applyProjectSetupInterview(edited, JSON.stringify({
    ...base, review: { skill: { name: "shift-handoff", description: "Store handoff", instructions: "Confirm break coverage." } },
  }), context).draft;
  expect(revised.proposals).toEqual([
    ...edited.proposals,
    expect.objectContaining({ path: ".agents/skills/shift-handoff/SKILL.md", status: "pending" }),
  ]);

  const dropped = applyProjectSetupInterview(revised, JSON.stringify({
    ...base, reply: "I’ll keep only the Skill.", review: { guidance: null },
  }), context).draft;
  expect(dropped.proposals.map(file => file.path)).toEqual([".agents/skills/shift-handoff/SKILL.md"]);
});

it("clears a previously generated Skill when the owner corrects the proposal", () => {
  const context = { project: { name: "Operations" }, skills: [], instructionFiles: [], mcpServices: [] };
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_skills", "project_ops", "Store operations", "msg_setup"));
  const review = applyProjectSetupInterview(draft, JSON.stringify({
    reply: "Review the handoff skill.", focus: "review", suggestions: [],
    answers: { skillInstructions: "Confirm break coverage." },
    review: { skill: { name: "shift-handoff", description: "Store handoff", instructions: "Confirm break coverage." } },
  }), context).draft;
  const revised = applyProjectSetupInterview(review, JSON.stringify({
    reply: "We’ll proceed without a skill.", focus: "review", suggestions: [],
    answers: { skillInstructions: null }, review: {},
  }), context).draft;
  expect(revised.skill).toBeUndefined();
  expect(revised.proposals).toEqual([]);
});

it("supplies complete pending file drafts and the latest correction to the interview", () => {
  const context = { project: { name: "Portfolio" }, skills: [], instructionFiles: [], mcpServices: [] };
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_archive", "archive", "Illustrations", "msg_setup"));
  const guidance = "# Project guidance\n" + "Preserve the release notes and shipped defaults.\n".repeat(35) + "Ask before publishing.\n";
  const skill = "---\nname: release-check\ndescription: Review a release\n---\n" + "Check the diff and summarize test results.\n".repeat(35) + "Keep dated review notes.\n";
  draft.proposals = [
    { path: "AGENTS.md", content: guidance, status: "pending" },
    { path: ".agents/skills/release-check/SKILL.md", content: skill, status: "pending" },
  ];
  const correction = { role: "user" as const, text: "Only change release recipients to the design team." };
  const data = JSON.parse(projectSetupInterviewPrompt(draft, context, [correction]).split("\n").at(-1)!);
  expect(data.reviewedDraft).toEqual(draft.proposals.map(({ path, content }) => ({ path, content })));
  expect(data.transcript).toEqual([correction]);

  // Quotes and backslashes double in the JSON prompt. The just-entered
  // answer still reaches the Agent, and the full file stays in Review.
  draft.proposals[0]!.content = '"\\'.repeat(30_000);
  const latest = { ...correction, text: "修正".repeat(2048) };
  const bounded = projectSetupInterviewPrompt(draft, context, [correction, latest]);
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(58 * 1024);
  const projected = JSON.parse(bounded.split("\n").at(-1)!);
  expect(projected.transcript.at(-1)).toEqual(latest);
  expect(projected.reviewedDraft).toEqual([
    { path: "AGENTS.md" }, { path: ".agents/skills/release-check/SKILL.md", content: skill },
  ]);
  expect(draft.proposals[0]!.content).toHaveLength(60_000);
});

it("retains accepted answer requirements after their original turns leave the interview transcript", () => {
  const context = { project: { name: "Portfolio" }, skills: [], instructionFiles: [], mcpServices: [] };
  const purpose = "A multilingual artwork archive. ".repeat(40) + "Include a contributors index.";
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_archive", "archive", purpose, "msg_setup"));
  draft.answers.guidance = "Preserve existing translation keys. ".repeat(40) + "Ask before publishing.";
  draft.answers.skillInstructions = "Check the changelog for every release. ".repeat(40) + "Keep dated review notes.";
  const history = Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, text: `Follow-up reply ${index}` }));
  const data = JSON.parse(projectSetupInterviewPrompt(draft, context, history).split("\n").at(-1)!);
  expect(data.interpretedAnswers).toEqual(draft.answers);
  expect(data.transcript).toEqual(history);
});

it("asks for a short actionable reply and accepts complete legacy answers and details", () => {
  const context = { project: { name: "Illustration archive" }, skills: [], instructionFiles: [], mcpServices: [] };
  const draft = beginProjectSetupInterview(initialProjectSetup("chat_archive", "archive", "Illustrations", "msg_setup"));
  const prompt = projectSetupInterviewPrompt(draft, context, []);
  expect(prompt).toContain("one short primary question");
  expect(prompt).toContain("32 characters");
  expect(prompt).toContain("Save longer explanations for Review");
  expect(prompt).not.toContain('"details":');
  const reply = "What will readers find in the archive?";
  const details = "Start with the public collection. Permissions and metadata can be discussed later.";
  const longAnswer = "The public collection plus an internal catalog for managing clearance.";
  const result = applyProjectSetupInterview(draft, JSON.stringify({
    reply, details, focus: "intent", suggestions: [longAnswer, "Public collection", "Public collection"],
  }), context);
  expect(result.assistantText).toBe(`${reply}\n\n${details}`);
  expect(result.draft.interview?.suggestions).toEqual([longAnswer, "Public collection"]);
});

describe("admitted project setup generation", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  beforeEach(async () => { pg = await createTestPGlite(); repository = new ChatRepository(pg.dialect); await repository.bootstrap(); });
  afterEach(async () => { await repository.kysely.destroy(); });
  it.each(["missing", "linked"] as const)("uses scoped Agent turns and preserves reviewed instructions with a %s CLAUDE.md", async companion => {
    const selection = { instanceId: "pi_default", model: "gpt-5.6-sol" };
    const available = catalog();
    available.instances[0]!.driverKind = "matrix_pi";
    available.instances[0]!.id = selection.instanceId;
    const catalogs = { getCatalog: async () => available };
    const roots: ChatExecutionRootResolver = {
      resolve: async (_owner, ref) => {
        if (ref.kind !== "project") throw new Error("Expected project root");
        return { ref, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: ref.projectId };
      },
      revalidate: async (scope, resolved) => roots.resolve(scope, resolved.ref),
    };
    const opening = { reply: "Which customers should receive the release notes?", focus: "intent", suggestions: ["All customers", "Beta customers"] };
    const accepted = "Draft updates for beta customers from Linear. Ask before publishing.";
    const review = { reply: "I’ll draft for beta customers and ask before publishing.", focus: "review", suggestions: [], recommendedService: "Linear",
      answers: { purpose: "Draft beta release notes", guidance: "Ask before publishing" }, review: { guidance: "# Project guidance\n\nAsk before publishing." } };
    const reviewWithoutMcp = { ...review, reply: "I’ll keep the project guidance and continue without an MCP connection.", recommendedService: undefined, review: {} };
    const storeOpening = { reply: "What part of a store shift would you like to make easier?", focus: "intent", suggestions: ["Shift handoff"] };
    const start = vi.fn(async function* () {
      const output = [opening, review, reviewWithoutMcp, storeOpening][start.mock.calls.length - 1];
      yield { type: "assistant.delta" as const, messageId: "result", delta: JSON.stringify(output) };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository, catalog: catalogs, executionRoots: roots,
      adapters: new CanonicalChatProviderRegistry([{ ...adapter(start), driverKind: "matrix_pi" }]),
    });
    const existingInstructions = "# Our release notes process";
    const create = vi.fn(async (_path: string, _content: string) => {});
    const service = new ProjectSetupService({
      repository, homePath: "/tmp/project-setup-tests", executionRoots: roots,
      openWorkspace: async (_owner, projectId) => ({
        fingerprint: "b".repeat(64), executionRootFingerprint, projectSlug: projectId, create, close: async () => {}, revalidate: async () => {},
        read: async path => {
          if (projectId !== "project_a") return null;
          if (path === "AGENTS.md") return existingInstructions;
          if (path === "CLAUDE.md" && companion === "linked") throw Object.assign(new Error("Symbolic link"), { code: "ELOOP" });
          return null;
        },
        interviewContext: async () => projectId === "project_a"
          ? { project: { name: "Release Notes", source: { type: "github", repository: "test-org/release-notes" } },
            instructionFiles: ["AGENTS.md"], skills: [], mcpServices: [{ name: "Linear", connection: "authorization_required" }] }
          : { project: { name: "Store Operations" }, instructionFiles: [], skills: [], mcpServices: [] },
      }),
      generation: { repository, orchestrator, catalog: catalogs },
    });
    try {
      expect((await service.getProject(owner, "project_a")).draft).toBeNull();
      expect(start).not.toHaveBeenCalled();
      const first = await service.start(owner, "project_a", { mode: "interview", clientRequestId: "req_interview_start", currentSelection: selection }, principal);
      const chatId = first.draft!.chatId;
      await orchestrator.drain();
      const sync = (revision: number, name: string, id = chatId) => service.update(principal, owner, id, {
        baseRevision: revision, clientRequestId: `req_sync_${name}`, action: { type: "sync_generation" },
      });
      // Simulate worker loss after canonical admission but before the setup row linked the run.
      await repository.kysely.updateTable("chat_project_setups")
        .set({ draft: jsonb({ ...first.draft, updatedAt: new Date(Date.now() - 61_000).toISOString(), generation: { status: "pending" } }) })
        .where("chat_id", "=", chatId).execute();
      const recovered = await sync(first.draft!.revision, "recovered");
      expect(recovered.draft?.generation).toMatchObject({ status: "running", runId: first.draft?.generation?.runId });
      expect(start).toHaveBeenCalledTimes(1);
      const opened = await sync(recovered.draft!.revision, "opening");
      expect(opened.draft?.interview?.suggestions).toEqual(opening.suggestions);
      const response = await service.update(principal, owner, chatId, { baseRevision: opened.draft!.revision,
        clientRequestId: "req_interview_answer", action: { type: "interview_answer", text: accepted, selection } });
      await orchestrator.drain();
      const result = await sync(response.draft!.revision, "review");
      const secondClient = await sync(response.draft!.revision, "review_second_client");
      expect(secondClient.draft).toEqual(result.draft);
      expect(result.draft?.step).toBe("review");
      expect(result.draft?.answers.guidance).toBe("Ask before publishing");
      expect(result.draft?.proposals.map(file => file.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(result.draft?.proposals[0]).toMatchObject({ content: existingInstructions, status: "already_present" });
      expect(result.draft?.proposals[1]?.status).toBe(companion === "linked" ? "symlink_skipped" : "pending");
      expect(result.draft?.mcp.state).toBe("not_requested");
      expect(create).not.toHaveBeenCalled();
      const page = await repository.getDetailPage(owner, chatId, { limit: 40 });
      const humanAnswer = page?.messages.filter(message => message.purpose === "discussion" && message.parts[0]?.type === "text" && message.parts[0].text === accepted);
      expect(humanAnswer).toHaveLength(1);
      expect(page?.messages.find(message => message.id === result.draft?.currentQuestionMessageId)).toMatchObject({
        role: "assistant", parts: [{ type: "text", text: review.reply }], turnId: humanAnswer?.[0]?.turnId,
      });
      const wires = await repository.kysely.selectFrom("chat_runs").select("context_snapshot").where("chat_id", "=", chatId).execute();
      expect(wires).toHaveLength(2);
      expect(wires).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
        context_snapshot: expect.objectContaining({ projectSetupDraft: expect.objectContaining({ mode: "interview" }) }),
      })));
      expect(page?.runs).toEqual([]);
      expect(start.mock.calls.map(call => JSON.stringify(call))).toEqual([expect.stringContaining("test-org/release-notes"), expect.stringContaining(accepted)]);
      expect(start.mock.calls.every(call => !JSON.stringify(call).includes(existingInstructions))).toBe(true);
      const connect = transitionProjectSetupInterview(result.draft!, { type: "choose_mcp", choice: "connect", service: "Linear" });
      expect(connect.draft.mcp).toEqual({ state: "pending", service: "Linear" });
      expect(transitionProjectSetupInterview(connect.draft, { type: "choose_mcp", choice: "skip" }).draft.mcp).toEqual({ state: "skipped" });
      const skip = await service.update(principal, owner, chatId, { baseRevision: result.draft!.revision,
        clientRequestId: "req_mcp_skip", action: { type: "choose_mcp", choice: "skip", selection } });
      expect(skip.draft?.mcp).toEqual({ state: "skipped" });
      await orchestrator.drain();
      const resultWithoutMcp = await sync(skip.draft!.revision, "review_without_mcp");
      expect(resultWithoutMcp.draft?.mcp).toEqual({ state: "skipped" });
      expect(JSON.stringify(start.mock.calls.at(-1))).toContain('"requestedConnection":{"state":"skipped"}'.replaceAll('"', '\\"'));
      const saved = await service.update(principal, owner, chatId, { baseRevision: resultWithoutMcp.draft!.revision,
        clientRequestId: "req_interview_save", action: { type: "save" } });
      expect(saved.draft?.step).toBe("saved");
      expect(create.mock.calls).toEqual(companion === "linked" ? [] : [["CLAUDE.md", "@AGENTS.md\n"]]);
      expect((await service.getProject(owner, "project_b")).draft).toBeNull();
      const store = await service.start(owner, "project_b", { mode: "interview", clientRequestId: "req_store_start", currentSelection: selection }, principal);
      await orchestrator.drain();
      const storeOpened = await sync(store.draft!.revision, "store_opening", store.draft!.chatId);
      expect(storeOpened.draft?.interview?.suggestions).toEqual(storeOpening.suggestions);
      const storeRequest = JSON.stringify(start.mock.calls.at(-1));
      expect(storeRequest).toContain("Store Operations");
      expect(storeRequest).not.toContain("Release Notes");
      expect(storeRequest).not.toContain(accepted);
    } finally { await orchestrator.close(); }
  });
  it("admits a Japanese correction on a full accepted draft and preserves its reviewed Markdown", async () => {
    const selection = { instanceId: "pi_default", model: "gpt-5.6-sol" };
    const available = catalog();
    available.instances[0]!.driverKind = "matrix_pi";
    available.instances[0]!.id = selection.instanceId;
    const catalogs = { getCatalog: async () => available };
    const roots: ChatExecutionRootResolver = {
      resolve: async (_owner, ref) => ({ ref, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project_a" }),
      revalidate: async (scope, resolved) => roots.resolve(scope, resolved.ref),
    };
    const answers = {
      purpose: "作品管理".repeat(1000),
      guidance: "整理手順".repeat(1000),
      skillInstructions: "公開確認".repeat(1000),
    };
    const correction = "公開前に必ず確認してください。";
    const review = { guidance: "# 作業方針\n" + "確認項目".repeat(1500),
      skill: { name: "review-release", description: "公開手順", instructions: "確認手順".repeat(1250) } };
    const start = vi.fn(async function* (_input: CanonicalProviderRunInput) {
      const output = [
        { reply: "何を確認しますか？", focus: "guidance", suggestions: [], answers },
        { reply: "保存する内容を確認してください。", focus: "review", suggestions: [], review },
        { reply: "公開前に確認します。", focus: "review", suggestions: [], review: {} },
      ][start.mock.calls.length - 1];
      const encoded = JSON.stringify(output);
      for (let offset = 0; offset < encoded.length; offset += 3_000) {
        yield { type: "assistant.delta" as const, messageId: "result", delta: encoded.slice(offset, offset + 3_000) };
      }
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository, catalog: catalogs, executionRoots: roots,
      adapters: new CanonicalChatProviderRegistry([{ ...adapter(start), driverKind: "matrix_pi" }]),
    });
    const create = vi.fn(async (_path: string, _content: string) => {});
    const service = new ProjectSetupService({
      repository, homePath: "/tmp/project-setup-tests", executionRoots: roots,
      generation: { repository, orchestrator, catalog: catalogs },
      openWorkspace: async () => ({
        fingerprint: "b".repeat(64), executionRootFingerprint, projectSlug: "project_a", create,
        close: async () => {}, revalidate: async () => {}, read: async () => null,
        interviewContext: async () => ({ project: { name: "作品管理" }, instructionFiles: [], skills: [], mcpServices: [] }),
      }),
    });
    const update = (draft: NonNullable<Awaited<ReturnType<typeof service.start>>["draft"]>, name: string,
      action: Parameters<typeof service.update>[3]["action"]) => service.update(principal, owner, draft.chatId, {
      baseRevision: draft.revision, clientRequestId: `req_${name}`, action,
    });
    const sync = async (draft: Parameters<typeof update>[0], name: string) => {
      await orchestrator.drain();
      return update(draft, name, { type: "sync_generation" });
    };
    try {
      const opening = await service.start(owner, "project_a", { mode: "interview", clientRequestId: "req_full_start", currentSelection: selection }, principal);
      const guidance = await sync(opening.draft!, "full_opened");
      expect(guidance.draft?.generation?.status).toBe("completed");
      expect(guidance.draft?.answers).toEqual(answers);
      const requestReview = await update(guidance.draft!, "request_review", { type: "interview_answer", text: "内容を確認します。", selection });
      const full = await sync(requestReview.draft!, "full_review");
      expect(full.draft?.step).toBe("review");
      expect(full.draft?.proposals[0]?.content).toBe(review.guidance);
      expect(full.draft?.proposals.at(-1)?.content).toContain(review.skill.instructions);
      const corrected = await update(full.draft!, "correct_full", { type: "interview_answer", text: correction, selection });
      expect(corrected.draft?.generation?.status).toBe("running");
      const reviewed = await sync(corrected.draft!, "review_corrected");
      expect(reviewed.draft?.generation?.status).toBe("completed");
      expect(reviewed.draft?.answers).toEqual(answers);
      expect(reviewed.draft?.proposals).toEqual(full.draft?.proposals);
      expect(start).toHaveBeenCalledTimes(3);
      const prompt = start.mock.calls.at(-1)![0].prompt;
      expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(58 * 1024);
      const modelInput = JSON.parse(prompt.split("\n").at(-1)!);
      expect(modelInput.transcript.at(-1)).toEqual({ role: "user", text: correction });
      expect(modelInput.interpretedAnswers).toEqual(answers);
      expect(modelInput.reviewedDraft).toEqual([
        { path: "AGENTS.md", content: review.guidance }, { path: ".agents/skills/review-release/SKILL.md" },
      ]);
      const saved = await update(reviewed.draft!, "save_full", { type: "save" });
      expect(saved.draft?.step).toBe("saved");
      expect(create.mock.calls).toEqual(full.draft!.proposals.map(file => [file.path, file.content]));
    } finally { await orchestrator.close(); }
  });
  it("starts a fresh restricted run instead of resuming a broader native session and binds its result", async () => {
    await repository.create(owner, { id: "chat_setup", clientRequestId: "req_create", title: "Project setup", projectId: "project_a" });
    const start = vi.fn(async function* () {
      yield { type: "state.updated" as const, state: { sessionId: "native_session" } };
      yield { type: "assistant.delta" as const, messageId: "process", delta: "I will draft your project guidance for review." };
      yield { type: "assistant.delta" as const, messageId: "result", delta: JSON.stringify({ guidance: "# Project guidance\n\nRun the relevant checks." }) };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const resume = vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "completed" as const }; });
    const provider = { ...adapter(start), resume };
    const available = catalog(); available.instances[0]!.supports.interactionModes.push("review");
    const catalogs = { getCatalog: async () => available };
    const roots = { resolve: async () => ({ ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project-a" }),
      revalidate: async () => ({ ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project-a" }) };
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: catalogs, adapters: new CanonicalChatProviderRegistry([provider]), executionRoots: roots });
    try {
      await orchestrator.admitTurn(principal, owner, "chat_setup", { clientRequestId: "req_ordinary", baseRevision: 0,
        parts: [{ type: "text", text: "An ordinary earlier turn" }], selection, interactionMode: "default", permissionMode: "supervised" });
      await orchestrator.drain();
      const latestCheckpoint = vi.spyOn(repository, "getLatestAdapterStateForChat");
      const draft = { ...initialProjectSetup("chat_setup", "project_a", "Portfolio", "msg_question"), revision: 7 };
      const generation = await generateProjectSetup({ repository, orchestrator, catalog: catalogs }, principal, owner, draft, selection, "req_generate", executionRootFingerprint);
      await orchestrator.drain();
      expect(latestCheckpoint).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(2);
      const run = await repository.kysely.selectFrom("chat_runs").selectAll().where("id", "=", generation.runId!).executeTakeFirstOrThrow();
      expect(run.permission_mode).toBe("supervised"); expect(run.interaction_mode).toBe("review");
      expect(run.context_snapshot).toMatchObject({ projectSetupDraft: { revision: 7 } });
      const result = await syncProjectSetupGeneration(repository, owner, { ...draft, generation }, executionRootFingerprint);
      expect(result.generation?.status).toBe("completed"); expect(result.proposals[0]?.content).toContain("relevant checks");
      await expect(syncProjectSetupGeneration(repository, owner, { ...draft, generation: { ...generation, sourceRevision: 8 } }, executionRootFingerprint)).rejects.toMatchObject({ kind: "conflict" });
      const pending = { ...draft, generation: { status: "pending" as const } };
      await expect(syncProjectSetupGeneration(repository, owner, pending, "b".repeat(64), "req_generate")).rejects.toMatchObject({ kind: "conflict" });
      await expect(syncProjectSetupGeneration(repository, { ...owner, ownerId: "other_user" }, pending, executionRootFingerprint, "req_generate")).resolves.toBe(pending);
    } finally { await orchestrator.close(); }
  });
  it("retries a failed draft through Project Setup without admitting a detached Chat retry", async () => {
    const chatId = "chat_setup_retry";
    const projectId = "project_a";
    await repository.create(owner, { id: chatId, clientRequestId: "req_create_retry", title: "Project setup", projectId });
    const start = vi.fn<Parameters<typeof adapter>[0]>(async function* () {
      yield { type: "assistant.delta" as const, messageId: "result", delta: JSON.stringify({ guidance: "# Project guidance\n\nVerify the change." }) };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    }).mockImplementationOnce(async function* () {
      yield { type: "run.completed" as const, outcome: "failed" as const };
    });
    const available = catalog(); available.instances[0]!.supports.interactionModes.push("review");
    const catalogs = { getCatalog: vi.fn(async () => available) };
    const root = { ref: { kind: "project" as const, projectId }, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project-a" };
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: catalogs,
      adapters: new CanonicalChatProviderRegistry([adapter(start)]), executionRoots: { resolve: async () => root, revalidate: async () => root } });
    try {
      const draft = { ...initialProjectSetup(chatId, projectId, "Portfolio", "msg_question"), step: "review" as const };
      const deps = { repository, orchestrator, catalog: catalogs };
      const generation = await generateProjectSetup(deps, principal, owner, draft, selection, "req_first_draft", executionRootFingerprint);
      await orchestrator.drain();
      const failed = await syncProjectSetupGeneration(repository, owner, { ...draft, generation }, executionRootFingerprint);
      expect(failed.generation?.status).toBe("failed");
      const turn = await repository.kysely.selectFrom("chat_runs").select("turn_id").where("id", "=", generation.runId!).executeTakeFirstOrThrow();
      const record = (await repository.get(owner, chatId))!;
      catalogs.getCatalog.mockClear();
      await expect(orchestrator.retryTurn(principal, owner, chatId, turn.turn_id, {
        clientRequestId: "req_canonical_retry", baseRevision: record.chat.revision,
      })).rejects.toMatchObject({ status: 409, safeError: { code: "run_unavailable", retryable: false, recoveryActions: [] } });
      expect(catalogs.getCatalog).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      const regenerated = await generateProjectSetup(deps, principal, owner, failed, selection, "req_retry_draft", executionRootFingerprint);
      await orchestrator.drain();
      expect(regenerated.runId).not.toBe(generation.runId);
      const result = await syncProjectSetupGeneration(repository, owner, { ...failed, generation: regenerated }, executionRootFingerprint);
      expect(result.generation?.status).toBe("completed");
      expect(result.answers).toEqual(draft.answers);
      expect(result.proposals[0]?.content).toContain("Verify the change.");
    } finally { await orchestrator.close(); }
  });
  it("declines unqualified drafting modes before admission", async () => {
    const admitTurn = vi.fn();
    const generation = await generateProjectSetup({ repository, orchestrator: { admitTurn }, catalog: { getCatalog: async () => catalog() } }, principal, owner,
      initialProjectSetup("chat_setup", "project_a", "Portfolio", "msg_question"), selection, "req_generate", executionRootFingerprint);
    expect(generation.status).toBe("unavailable"); expect(admitTurn).not.toHaveBeenCalled();
  });
  it("keeps interview wire text out of the visible Chat and Side Chat context", async () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const chatId = snapshot.chat.id;
    await repository.create(owner, { id: chatId, title: "Release notes", clientRequestId: "req_setup_preview_test" });
    const ownerText = "Use the changelog for each release.";
    const ownerMessageId = await repository.kysely.transaction().execute(trx =>
      appendProjectSetupTranscript(trx, owner, chatId, [{ role: "user", text: ownerText }], async () => undefined));
    const sourceRun = snapshot.runs[0]!;
    const run = { ...sourceRun, historyBoundarySeq: 1,
      context: { version: 1 as const, requestHash: "a".repeat(64), chats: [],
        projectSetupDraft: { mode: "interview" as const, revision: 1 } } };
    const turn = { ...snapshot.turns[0]!, baseMessageSeq: 1 };
    await repository.admitTurn(owner, {
      chatId, baseRevision: 1, turn, run, adapterState: { schemaVersion: 1, state: { sessionId: "interview_wire" } },
      message: { ...snapshot.messages[0]!, seq: 2,
        parts: [{ type: "text", text: "internalsetupinstruction" }] },
    });
    const admitted = await repository.get(owner, chatId);
    expect.soft(admitted?.chat.lastMessagePreview).toBe(ownerText);
    expect.soft(admitted?.providerBinding).toBeUndefined();

    const delta = '{"reply":"internalsetuppayload"}';
    await repository.appendAssistantDelta(owner, {
      chatId, runId: run.id, messageId: "msg_interview_raw", delta, createdAt: run.createdAt,
    });
    expect.soft((await repository.get(owner, chatId))?.chat.lastMessagePreview).toBe(ownerText);
    await repository.finishRun(owner, {
      chatId, runId: run.id, outcome: "completed", completedAt: run.createdAt,
    });
    const completed = await repository.get(owner, chatId);
    expect.soft(completed?.chat.lastMessagePreview).toBe(ownerText);
    const internal = await repository.kysely.selectFrom("chat_messages").select("state")
      .where("id", "=", "msg_interview_raw").executeTakeFirstOrThrow();
    expect.soft(internal.state).toBe("committed");
    expect.soft(completed?.readState).toMatchObject({ unread: false, latestIncomingSeq: 0 });
    expect.soft((await repository.list(owner, { limit: 1, unreadOnly: true })).items).toEqual([]);
    await expect.soft(repository.getLatestAdapterStateForChat(owner, { chatId, driverKind: run.driverKind,
      instanceId: run.instanceId, schemaVersion: 1, executionRootFingerprint: run.executionRootFingerprint! })).resolves.toBeNull();
    await expect.soft(repository.search(owner, "internalsetupinstruction")).resolves.toEqual([]);
    await expect.soft(repository.search(owner, "internalsetuppayload")).resolves.toEqual([]);
    await expect.soft(repository.search(owner, "changelog")).resolves.toHaveLength(1);
    const detail = await repository.getDetailPage(owner, chatId, { limit: 1 });
    expect.soft(detail?.messages.flatMap(({ parts }) => parts)).toEqual([{ type: "text", text: ownerText }]);
    expect.soft(detail?.nextBeforeSeq).toBeUndefined();
    const events = await repository.kysely.selectFrom("chat_outbox").select("payload").execute();
    expect(JSON.stringify(events)).not.toMatch(/internalsetup(?:instruction|payload)/);

    await repository.kysely.transaction().execute(trx => appendProjectSetupTranscript(trx, owner, chatId, [
      { role: "assistant", anchorMessageId: ownerMessageId, text: "Who reviews the changelog?" },
    ], async () => undefined));
    const incoming = (await repository.list(owner, { limit: 1, unreadOnly: true })).items[0];
    expect(incoming?.readState).toMatchObject({ unread: true, latestIncomingSeq: 4 });
    const read = await repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 4, baseVersion: 0 });
    expect(read.readState).toMatchObject({ unread: false, latestIncomingSeq: 4 });

    const sideChats = new SideChatRepository(repository.kysely);
    await sideChats.create(owner, chatId);
    const generate = vi.fn(async (_prompt: string) => ({ text: "Review the changelog before release." }));
    await sideChats.ask(owner, chatId, { clientRequestId: "req_setup_side", text: "What should I review?" }, generate);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain(`user: ${ownerText}`);
    expect(prompt).toContain("assistant: Who reviews the changelog?");
    expect(prompt).not.toMatch(/internalsetup(?:instruction|payload)/);
  });
});

describe("project setup context", () => {
  const owner = { type: "personal", ownerId: "owner_setup" } as const;
  let home: string | undefined;
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; });

  it.runIf(process.platform === "linux")("reads bounded names from the pinned, owner-scoped checkout with safe GitHub identity", async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-setup-context-"));
    const root = join(home, "allowed");
    const other = join(home, "other");
    await mkdir(join(root, ".agents/skills/release-review"), { recursive: true });
    await mkdir(join(other, ".agents/skills/private-skill"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "PRIVATE_INSTRUCTIONS_DO_NOT_SEND");
    await writeFile(join(root, ".agents/skills/release-review/SKILL.md"), "PRIVATE_SKILL_CONTENT_DO_NOT_SEND");
    await writeFile(join(other, "AGENTS.md"), "PRIVATE_OTHER_PROJECT");
    await writeFile(join(other, ".agents/skills/private-skill/SKILL.md"), "PRIVATE_OTHER_SKILL");
    await symlink(join(other, ".agents/skills/private-skill"), join(root, ".agents/skills/private-skill"));
    await link(join(other, "AGENTS.md"), join(root, "CLAUDE.md"));
    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{"SecretMcpName":{"url":"https://secret.example.com"}}}');
    const project = { id: "proj_github", slug: "allowed", name: "Acorn site", description: "A team website", kind: "github" as const,
      localPath: root, remote: "https://ACCOUNT_SECRET@github.com/finna/acorn", github: { owner: "finna", repo: "acorn" } };
    const roots = createChatExecutionRootResolver({ homePath: home, projects: {
      getProjectById: async (scope, id) => scope.id === owner.ownerId && id === project.id
        ? { ok: true, project } : { ok: false, status: 404, error: "missing" },
      resolveProjectWorkingDirectory: async entry => entry.localPath,
    }, worktrees: { getWorktree: async () => ({ ok: false, status: 404, error: "missing" }) } });
    const mcp = vi.fn(async () => [{ name: "Linear", connection: "connected" as const }]);
    await expect(openProjectSetupWorkspace(roots, home, { ...owner, ownerId: "different_owner" }, project.id, mcp)).rejects.toThrow();
    expect(mcp).not.toHaveBeenCalled();
    const workspace = await openProjectSetupWorkspace(roots, home, owner, project.id, mcp);
    try {
      expect(await workspace.interviewContext!()).toEqual({
        project: { name: "Acorn site", description: "A team website", source: { type: "github", repository: "finna/acorn" } },
        instructionFiles: ["AGENTS.md"],
        skills: [{ name: "release-review", path: ".agents/skills/release-review/SKILL.md" }],
        mcpServices: [{ name: "Linear", connection: "connected" }],
      });
    } finally { await workspace.close(); }
  });

  it("projects broker status and catalog names without forwarding URLs, tool metadata, or cross-owner access", async () => {
    const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith("/catalog") ? {
      presets: [
        { name: "Linear", url: "https://linear.example.com/mcp", auth: "oauth", description: "CATALOG_RAW" },
        { name: "Stripe", url: "https://stripe.example.com/mcp", auth: "oauth" },
        { name: "Read docs", url: "https://docs.example.com/mcp", auth: "none" },
      ],
    } : [
      { name: "My Linear", url: "https://linear.example.com/mcp", enabled: true, status: "ready", tools: [{ inputSchema: "PRIVATE_DETAILS" }] },
      { name: "Stripe", url: "https://stripe.example.com/mcp", enabled: true, status: "auth_required" },
      { name: "Stripe", url: "https://different.example.com/mcp", enabled: true, status: "ready" },
      { name: "Disabled", url: "https://disabled.example.com/mcp", enabled: false, status: "disabled" },
      { name: "Manual", url: "https://other.example.com/mcp", enabled: true, status: "degraded" },
    ])));
    const registration = registerCustomMcpGatewayRoutes(new Hono(), {
      homePath: tmpdir(), clerkUserId: owner.ownerId, fetchInterviewInventory: fetcher,
      platformProxy: { internalPlatformUrl: "https://platform.example.com", handle: "workspace-dev", token: "machine-token", request: vi.fn() },
    });
    try {
      expect(await registration.listProjectSetupMcpServices({ ...owner, ownerId: "other-owner" })).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await registration.listProjectSetupMcpServices(owner)).toEqual([
        { name: "Linear", connection: "connected" },
        { name: "Stripe", connection: "authorization_required" },
        { name: "Manual", connection: "unconfirmed" },
        { name: "Read docs", connection: "unconfirmed" },
      ]);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        "https://platform.example.com/internal/containers/workspace-dev/mcp-servers",
        "https://platform.example.com/internal/containers/workspace-dev/mcp-servers/catalog",
      ]);
      for (const [, options] of fetcher.mock.calls) {
        expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
      }
    } finally { registration.stop(); }
  });
});
