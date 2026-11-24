import type {} from "../../../desktop/src/renderer/src/lib/operator";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatContentFrameSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatNavigationItemSchema,
  CanonicalChatNavigationResponseSchema,
  CanonicalChatRecordSchema,
  ProjectSetupResponseSchema,
  ProjectSetupStartRequestSchema,
  ProjectSetupUpdateRequestSchema,
  type CanonicalChatMessage,
  type CanonicalChatTurn,
  type CanonicalChatRun,
  type ProjectSetupDraft,
} from "@matrix-os/contracts";
import {
  initialProjectSetup,
  applyProjectSetupGeneration,
} from "../../../packages/gateway/src/chat/project-setup-state";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat";
import { dismissGettingStartedOnInteraction } from "./fixtures/getting-started";
import { closeElectronApp } from "./fixtures/close-electron";
import { startStubGateway, type StubGateway } from "./fixtures/stub-gateway";

const root = resolve(import.meta.dirname, "../../..");
const main = process.env.MATRIX_PROJECT_SETUP_DESKTOP_MAIN ?? join(root, "desktop/out/main/index.js");
const built = existsSync(main);
if (process.env.MATRIX_DESKTOP_E2E_REQUIRED === "1" && !built)
  throw new Error("Required Electron Desktop build is missing");
const evidence = process.env.MATRIX_PROJECT_SETUP_EVIDENCE_DIR ?? join(root, "output/project-chat-setup-fixture");
const project = { id: "proj_setup_atlas", slug: "atlas", name: "Atlas setup fixture", kind: "scratch" };
const openingQuestion = "What should readers be able to find in the Atlas illustration archive?";
const purpose = "Build a public illustration archive. Keep changes small, ask before publishing, and use Linear for releases.";
const skillQuestion = "What should the release checklist verify before an illustration goes public?";
const skillSuggestion = "Review the diff and collect the test results.";
const toolQuestion = "I can use Linear to look up approved release work. Would you like to connect it?";
const reviewReply = "I drafted the archive guidance and release checklist. Review the Markdown before saving.";
const internalPrompt = "Project setup interview.";
const internalReply = '{"reply":"Unprojected proposal","focus":"review","suggestions":[]}';
const savedReply = "Your project setup files are saved.";
const chatId = "chat_project_setup_fixture";
const now = "2026-11-22T12:00:00.000Z";
const fixture = createCanonicalChatFixture("idle");
const completed = createCanonicalChatFixture("completed").snapshot.runs[0]!;
const { project: ignoredProject, ...baseChat } = fixture.snapshot.chat;

/** Local contract fixture only. It never invokes a provider or changes a real project. */
function setupFixture() {
  let draft: ProjectSetupDraft | null = null;
  let chatRevision = 0;
  let cursor = 0;
  let publishedMessageCount = 0;
  let publishedTurnCount = 0;
  let publishedRunCount = 0;
  const streams = new Set<ServerResponse>(); // Maximum four fixture streams, drained on teardown.
  const messages: CanonicalChatMessage[] = [];
  const turns: CanonicalChatTurn[] = [];
  const runs: CanonicalChatRun[] = [];
  const files = new Map<string, string>(); // Three bounded setup destinations in this disposable fixture.
  const mutations: string[] = [];
  const actions: string[] = [];
  const record = () =>
    CanonicalChatRecordSchema.parse({
      chat: {
        ...baseChat,
        id: chatId,
        ownerScope: { type: "personal", ownerId: "user-1" },
        title: "Project setup",
        currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
        revision: chatRevision,
        messageCount: messages.length,
        activityAt: now,
        createdAt: now,
        updatedAt: now,
      },
      projectId: project.id,
    });
  const detail = () =>
    CanonicalChatDetailResponseSchema.parse({
      record: record(),
      messages,
      turns,
      runs,
      activities: [],
      queuedTurns: [],
    });
  const append = (userText: string, assistantText: string, runId?: string) => {
    const turnId = `cturn_setup_${turns.length + 1}`;
    const inputMessageId = `msg_setup_${messages.length + 1}`;
    turns.push({
      id: turnId,
      chatId,
      clientRequestId: `req_setup_${turns.length + 1}`,
      inputMessageId,
      baseMessageSeq: messages.length,
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    for (const [role, text] of [
      ["user", userText],
      ["assistant", assistantText],
    ] as const) {
      messages.push({
        id: `msg_setup_${messages.length + 1}`,
        chatId,
        turnId,
        ...(role === "assistant" && runId ? { runId } : {}),
        seq: messages.length + 1,
        role,
        purpose: role === "user" ? "discussion" : "assistant",
        state: "committed",
        parts: [{ type: "text", text }],
        createdAt: now,
      });
    }
    if (runId) {
      runs.push({
        ...completed, id: runId, chatId, turnId,
        context: {
          version: 1, requestHash: "a".repeat(64), chats: [],
          projectSetupDraft: { mode: "interview", revision: draft!.revision },
        },
        executionRoot: { kind: "project", projectId: project.id },
      });
    }
    chatRevision++;
    return messages.at(-1)!.id;
  };
  const publish = () => {
    cursor++;
    const event = { cursor, revision: chatRevision, chatId, eventType: "chat.updated", createdAt: now };
    const frame = CanonicalChatContentFrameSchema.parse({
      type: "chat.content",
      event,
      content: {
        record: record(),
        messages: messages.slice(publishedMessageCount),
        turns: turns.slice(publishedTurnCount),
        runs: runs.slice(publishedRunCount),
        queuedTurns: [],
      },
    });
    for (const stream of streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`);
    publishedMessageCount = messages.length;
    publishedTurnCount = turns.length;
    publishedRunCount = runs.length;
  };
  const navigation = () => CanonicalChatNavigationResponseSchema.parse({
    version: 1,
    truncated: false,
    items: draft ? [{
      chat: CanonicalChatNavigationItemSchema.shape.chat.strip().parse(record().chat),
      projectId: project.id,
      classification: { kind: "ordinary" },
      persistence: "personal",
      readState: {
        version: 0,
        unread: false,
        markedUnread: false,
        latestIncomingSeq: messages.length,
        readThroughSeq: messages.length,
      },
    }] : [],
  });
  return {
    streams,
    messages,
    turns,
    files,
    mutations,
    actions,
    record,
    detail,
    navigation,
    publish,
    get draft() {
      return draft;
    },
    start(input: unknown) {
      const body = ProjectSetupStartRequestSchema.parse(input);
      if (!("mode" in body) || body.mode !== "interview") throw new Error("Expected an explicit Agent setup start");
      const messageId = append("Set up this project with Chat.", openingQuestion);
      draft = {
        ...initialProjectSetup(chatId, project.id, project.name, messageId),
        answers: { purpose: "" },
        interview: { focus: "intent", suggestions: ["Publish an illustration archive", "Share works in progress"] },
        generation: { status: "completed" },
      };
      return ProjectSetupResponseSchema.parse({ draft, record: record() });
    },
    update(input: unknown) {
      const body = ProjectSetupUpdateRequestSchema.parse(input);
      if (!draft || draft.revision !== body.baseRevision) throw new Error("Fixture revision conflict");
      const { action } = body;
      actions.push(action.type);
      let next = structuredClone(draft);
      if (action.type === "interview_answer" && next.interview?.focus === "intent") {
        expect(action.text).toBe(purpose);
        next.answers = { purpose, guidance: "Keep changes small and ask before publishing." };
        next.interview = { focus: "skill", suggestions: [skillSuggestion] };
        next.step = "skill";
        next.currentQuestionMessageId = append(action.text, skillQuestion);
      } else if (action.type === "interview_answer" && next.interview?.focus === "skill") {
        expect(action.text).toBe(skillSuggestion);
        next.answers.skillInstructions = action.text;
        next.interview = { focus: "mcp", suggestions: [], recommendedService: "Linear" };
        next.step = "mcp";
        next.currentQuestionMessageId = append(action.text, toolQuestion);
      } else if (action.type === "choose_mcp" && action.choice === "connect" && next.interview) {
        expect(action.service).toBe("Linear");
        next.mcp = { state: "pending", service: action.service };
        next.interview.mcpHandoff = true;
      } else if (action.type === "interview_answer" && next.interview?.focus === "mcp") {
        const generated = JSON.stringify({
          guidance: "# Atlas illustration archive\n\nKeep changes small and ask before publishing.\n",
          skill: {
            name: "release-check",
            description: "Check a release before publishing",
            instructions: "Run the relevant tests, review the diff, and summarize the changes.",
          },
        });
        next = applyProjectSetupGeneration(
          { ...next, step: "review", interview: { focus: "review", suggestions: [] } },
          generated,
        );
        append(internalPrompt, internalReply, "run_setup_interview");
        next.currentQuestionMessageId = append(action.text, reviewReply);
      } else if (action.type === "save") {
        for (const file of next.proposals) {
          files.set(file.path, file.content);
          file.status = "saved";
        }
        next.step = "saved";
        next.currentQuestionMessageId = append("Save this project setup.", savedReply);
      } else if (action.type !== "sync_generation") {
        throw new Error("Unexpected project setup action");
      }
      draft = { ...next, revision: draft.revision + 1, updatedAt: now };
      return ProjectSetupResponseSchema.parse({ draft, record: record() });
    },
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req.setEncoding("utf8")) {
    text += chunk;
    if (text.length > 256 * 1024) throw new Error("Fixture body too large");
  }
  return JSON.parse(text);
}

describe.skipIf(!built)("Electron Desktop guided project setup contract fixture", () => {
  let base: StubGateway;
  let app: ElectronApplication;
  let page: Page;
  let profile: string;
  const state = setupFixture();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" && (path.endsWith("/setup") || path.endsWith("/project-setup") || path.endsWith("/turns") || path === "/api/chats")) {
      state.mutations.push(`${req.method} ${path}`);
    }
    if (path === "/api/chats/events") {
      if (state.streams.size >= 4) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"chat.stream.attached"}\n\ndata: {"type":"chat.replay.end"}\n\n');
      state.streams.add(res);
      res.on("close", () => state.streams.delete(res));
      return;
    }
    if (path === "/api/workspace/projects") return json({ projects: [project] });
    if (path === "/api/chat-providers") return json(fixture.providerCatalog);
    if (path === "/api/chat-agents") return json({ enabled: true, agents: [] });
    if (path === `/api/chats/${chatId}/bot`) return json({ agentId: null });
    if (path === "/api/chat-navigation") return json(state.navigation());
    if (path === "/api/chats")
      return json(CanonicalChatListResponseSchema.parse({ items: state.draft ? [state.record()] : [] }));
    if (path === `/api/chats/${chatId}`) return json(state.detail());
    if (path === `/api/chats/${chatId}/read-state`) {
      req.resume();
      return json(state.record());
    }
    if (path.endsWith("/routine-origin"))
      return json({ sourceChatId: chatId, pending: [], deliveries: [], deliveryPending: false, hasMore: false });
    if (path === `/api/projects/${project.id}/setup` || path === `/api/chats/${chatId}/project-setup`) {
      if (req.method === "GET") return json(ProjectSetupResponseSchema.parse({ draft: state.draft }));
      void readBody(req)
        .then((body) => {
          json(req.method === "POST" ? state.start(body) : state.update(body));
          state.publish();
        })
        .catch((error) => {
          console.error("Setup fixture rejected request", error instanceof Error ? error.message : "UnknownError");
          if (!res.headersSent) res.writeHead(409);
          res.end();
        });
      return;
    }
    if (path === `/api/projects/${project.id}/agent-context`)
      return json({
        instructions: ["AGENTS.md", "CLAUDE.md"].filter((file) => state.files.has(file)),
        configFiles: [],
        skills: state.files.has(".agents/skills/release-check/SKILL.md")
          ? [{ name: "release-check", source: ".agents/skills" }]
          : [],
        mcpServers: [],
        incompleteSources: [],
      });
    if (path === "/api/mcp-servers" || path === "/api/settings/skills") return json([]);
    const upstream = request(
      new URL(req.url ?? "/", base.url),
      { method: req.method, headers: req.headers, timeout: 10_000 },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("Fixture timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  const openProject = async () => {
    await page.getByRole("button", { name: "Search", exact: true }).click({ timeout: 20_000 });
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByPlaceholder("Type a command or search…").fill(project.name);
    await palette.getByRole("option", { name: project.name, exact: true }).click();
    await page.getByRole("heading", { name: project.name, exact: true }).waitFor();
  };

  beforeAll(async () => {
    await mkdir(evidence, { recursive: true });
    base = await startStubGateway();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    profile = await mkdtemp(join(tmpdir(), "matrix-project-setup-e2e-"));
    app = await _electron.launch({
      executablePath: createRequire(join(root, "desktop/package.json"))("electron") as string,
      args: [main],
      env: {
        ...process.env,
        OPERATOR_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        OPERATOR_USER_DATA_DIR: profile,
      },
    });
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {};
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await dismissGettingStartedOnInteraction(page);
    await page.getByRole("button", { name: /create account/i }).waitFor();
    await page.evaluate(() => window.operator.invoke("auth:start-device-flow", {}));
  }, 60_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    for (const stream of state.streams) stream.end();
    state.streams.clear();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await base?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  it("skips cleanly and renders Agent suggestions, MCP Settings and explicit review in one project Chat", async () => {
    onTestFailed(async () => {
      if (!page?.isClosed()) {
        console.error((await page.locator("body").ariaSnapshot({ timeout: 2_000 })).slice(0, 5000));
        await page.screenshot({ path: join(evidence, "electron-setup-fixture-failure.png"), timeout: 2_000 });
      }
    });
    await openProject();
    await page.getByRole("dialog", { name: "Chat window", exact: true })
      .getByRole("button", { name: "Maximize", exact: true }).click();
    await page.getByRole("button", { name: "Skip for now", exact: true }).click();
    expect(state.mutations).toEqual([]);
    expect(state.draft).toBeNull();
    await page.getByRole("button", { name: "Set up with Chat", exact: true }).click();
    await page.getByText(openingQuestion, { exact: true }).waitFor({ timeout: 8_000 });
    expect(state.draft?.chatId).toBe(chatId);
    await page.getByRole("button", { name: "Publish an illustration archive", exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, "electron-setup-fixture-custom-answer.png") });
    const composer = page.locator('[contenteditable="true"]').last();
    const messages = page.getByRole("region", { name: "Messages", exact: true });
    await composer.fill(purpose);
    await composer.press("Enter");
    await messages.getByText(purpose, { exact: true }).waitFor();
    expect(state.draft).toMatchObject({ chatId, answers: { purpose } });
    expect(await page.getByText("Worked for 0s", { exact: true }).count()).toBe(0);
    const question = messages.getByText(skillQuestion, { exact: true });
    const suggestion = page.getByRole("button", { name: skillSuggestion, exact: true });
    await suggestion.waitFor();
    const questionBox = await question.boundingBox();
    const choiceBox = await suggestion.boundingBox();
    expect(choiceBox!.y - (questionBox!.y + questionBox!.height)).toBeLessThan(22);
    await suggestion.click();
    await messages.getByText(skillSuggestion, { exact: true }).waitFor();
    await messages.getByText(toolQuestion, { exact: true }).waitFor();
    expect(state.draft?.answers.skillInstructions).toBe(skillSuggestion);
    await page.getByRole("button", { name: "Connect Linear", exact: true }).click();
    await page.getByRole("button", { name: "Open MCP Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings window", exact: true });
    await settings.getByRole("heading", { name: "MCP servers", exact: true }).waitFor();
    expect(state.draft?.mcp).toEqual({ state: "pending", service: "Linear" });
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    const focusChat = page.getByRole("button", { name: "Focus Chat", exact: true });
    if (await focusChat.isVisible()) await focusChat.click();
    await page.getByText("Awaiting MCP authorization", { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, "electron-setup-fixture-mcp-authorization.png") });
    await page.getByRole("button", { name: "Continue setup", exact: true }).click();
    await messages.getByText(reviewReply, { exact: true }).waitFor();
    expect(await messages.getByText(internalPrompt, { exact: true }).count()).toBe(0);
    expect(await messages.getByText(internalReply, { exact: true }).count()).toBe(0);
    await page.getByRole("region", { name: "Review AGENTS.md", exact: true }).waitFor();
    expect(state.files.size).toBe(0);
    await page.getByRole("region", { name: "Review .agents/skills/release-check/SKILL.md", exact: true }).waitFor();
    expect(state.draft?.mcp.state).toBe("pending");
    expect(await page.getByRole("button", { name: "Open MCP Settings", exact: true }).count()).toBe(0);
    expect(state.files.size).toBe(0);
    await page.screenshot({ path: join(evidence, "electron-setup-fixture-review.png") });
    await page.getByRole("button", { name: "Save project setup", exact: true }).click();
    await page.getByText(savedReply, { exact: true }).waitFor();
    expect([...state.files.keys()].sort()).toEqual([".agents/skills/release-check/SKILL.md", "AGENTS.md", "CLAUDE.md"]);
    expect(state.actions).toContain("save");
    await page.screenshot({ path: join(evidence, "electron-setup-fixture-saved.png") });
    await openProject();
    await page.getByRole("button", { name: "Agent configuration", exact: true }).click();
    await page
      .getByRole("region", { name: "Skills", exact: true })
      .getByText("release-check", { exact: true })
      .waitFor();
    await page.locator('[contenteditable="true"]').last().fill("/");
    await page.getByRole("option").filter({ hasText: "release-check" }).waitFor();
  }, 90_000);
});
