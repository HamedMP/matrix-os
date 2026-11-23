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
  transitionProjectSetup,
  applyProjectSetupGeneration,
  PROJECT_SETUP_QUESTIONS,
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
        ...(runId ? { runId } : {}),
        seq: messages.length + 1,
        role,
        purpose: role === "user" ? "discussion" : "assistant",
        state: "committed",
        parts: [{ type: "text", text }],
        createdAt: now,
      });
    }
    if (runId)
      runs.push({ ...completed, id: runId, chatId, turnId, executionRoot: { kind: "project", projectId: project.id } });
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
      const messageId = append(body.answer, PROJECT_SETUP_QUESTIONS.guidance);
      draft = initialProjectSetup(chatId, project.id, body.answer, messageId);
      return ProjectSetupResponseSchema.parse({ draft, record: record() });
    },
    update(input: unknown) {
      const body = ProjectSetupUpdateRequestSchema.parse(input);
      if (!draft || draft.revision !== body.baseRevision) throw new Error("Fixture revision conflict");
      actions.push(body.action.type);
      const transition = transitionProjectSetup(draft, body.action);
      let next = transition.draft;
      if (body.action.type === "generate") {
        const generated = JSON.stringify({
          guidance: "# Atlas project\n\nKeep changes small and run the relevant tests.\n",
          skill: {
            name: "release-check",
            description: "Check a release before publishing",
            instructions: "Run the relevant tests, review the diff, and summarize the changes.",
          },
        });
        next = applyProjectSetupGeneration(
          { ...next, generation: { runId: "run_setup_generation", status: "running" } },
          generated,
        );
        next.currentQuestionMessageId = append(
          "Draft the project files for review.",
          generated,
          "run_setup_generation",
        );
      } else if (body.action.type === "save") {
        for (const file of next.proposals) {
          files.set(file.path, file.content);
          file.status = "saved";
        }
        next.step = "saved";
        next.currentQuestionMessageId = append("Save project setup.", PROJECT_SETUP_QUESTIONS.saved);
      } else if (transition.userText && transition.assistantText) {
        next.currentQuestionMessageId = append(transition.userText, transition.assistantText);
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
    if (req.method !== "GET") state.mutations.push(`${req.method} ${path}`);
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

  it("skips cleanly, then uses custom Chat answers and explicitly reviews the MCP and file changes", async () => {
    onTestFailed(async () => {
      if (!page?.isClosed()) {
        console.error((await page.locator("body").ariaSnapshot({ timeout: 2_000 })).slice(0, 5000));
        await page.screenshot({ path: join(evidence, "electron-setup-fixture-failure.png"), timeout: 2_000 });
      }
    });
    await openProject();
    const beforeSkip = [...state.mutations];
    await page.getByRole("button", { name: "Skip for now", exact: true }).click();
    expect(state.mutations).toEqual(beforeSkip);
    expect(state.draft).toBeNull();
    await page.getByRole("button", { name: "Set up with Chat", exact: true }).click();
    await page.getByText(`What are you using ${project.name} for?`, { exact: true }).waitFor();
    expect(state.draft).toBeNull();
    await page.screenshot({ path: join(evidence, "electron-setup-fixture-custom-answer.png") });
    const composer = page.locator('[contenteditable="true"]').last();
    const messages = page.getByRole("region", { name: "Messages", exact: true });
    const purpose = "A public archive for my illustration portfolio.";
    await composer.fill(purpose);
    await composer.press("Enter");
    await messages.getByText(purpose, { exact: true }).waitFor();
    await page.getByText(PROJECT_SETUP_QUESTIONS.guidance.split("\n\n")[0]!, { exact: true }).waitFor();
    expect(state.draft).toMatchObject({ chatId, answers: { purpose } });
    expect(await page.getByText("Worked for 0s", { exact: true }).count()).toBe(0);
    const guidanceQuestion = page.getByText(PROJECT_SETUP_QUESTIONS.guidance.split("\n\n").at(-1)!, { exact: true });
    const guidanceChoice = page.getByRole("button", { name: "Keep changes small", exact: true });
    await guidanceChoice.waitFor();
    const questionBox = await guidanceQuestion.boundingBox();
    const choiceBox = await guidanceChoice.boundingBox();
    expect(choiceBox!.y - (questionBox!.y + questionBox!.height)).toBeLessThan(22);
    await composer.fill("Keep changes small, run the checks, and ask before publishing.");
    await composer.press("Enter");
    await page.getByText(PROJECT_SETUP_QUESTIONS.skill.split("\n\n")[0]!, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Create a skill", exact: true }).click();
    await page.getByText(PROJECT_SETUP_QUESTIONS.skill_instructions.split("\n\n")[0]!, { exact: true }).waitFor();
    const skill = "Review the diff and list the checks for every release.";
    await composer.fill(skill);
    await composer.press("Enter");
    await messages.getByText(skill, { exact: true }).waitFor();
    await page.getByText(PROJECT_SETUP_QUESTIONS.mcp.split("\n\n")[0]!, { exact: true }).waitFor();
    expect(state.draft?.answers.skillInstructions).toBe(skill);
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
    await page.getByRole("button", { name: "Continue to review", exact: true }).click();
    await page.getByRole("region", { name: "Review AGENTS.md", exact: true }).waitFor();
    expect(state.files.size).toBe(0);
    await page.getByRole("button", { name: /^(Draft project files|Regenerate drafts)$/ }).click();
    await page
      .getByText("I drafted your project guidance and skill. Review the Markdown below before saving.", { exact: true })
      .waitFor();
    await page.getByRole("region", { name: "Review .agents/skills/release-check/SKILL.md", exact: true }).waitFor();
    expect(state.draft?.mcp.state).toBe("pending");
    expect(await page.getByRole("button", { name: "Open MCP Settings", exact: true }).count()).toBe(0);
    expect(state.files.size).toBe(0);
    await page.screenshot({ path: join(evidence, "electron-setup-fixture-review.png") });
    await page.getByRole("button", { name: "Save project setup", exact: true }).click();
    await page.getByText(PROJECT_SETUP_QUESTIONS.saved, { exact: true }).waitFor();
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
