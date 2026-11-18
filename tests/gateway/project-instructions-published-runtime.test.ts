import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createChatExecutionRootResolver, type ResolvedChatExecutionRoot } from "../../packages/gateway/src/chat/execution-root.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";

const exec = promisify(execFile);
const owner = { type: "personal" as const, ownerId: "owner_project_instructions" };
const ownerScope = { type: "user" as const, id: owner.ownerId };
const parentMarker = "MATRIX_PARENT_INSTRUCTIONS";
const primaryMarker = "MATRIX_PRIMARY_AGENTS_INSTRUCTIONS";
const worktreeMarker = "MATRIX_WORKTREE_OVERRIDE_INSTRUCTIONS";
const ignoredMarker = "MATRIX_WORKTREE_SHADOWED_INSTRUCTIONS";
const siblingMarker = "MATRIX_SIBLING_AGENTS_INSTRUCTIONS";
const claudeMarker = "MATRIX_PROJECT_CLAUDE_INSTRUCTIONS";
const fixtureAnswer = "Project instructions fixture answer.";
const fixtureKey = "matrix-instructions-fixture-credential";

function git(cwd: string, ...args: string[]) {
  return exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 5_000,
  });
}

async function isolatedFixture(run: (root: string) => Promise<void>) {
  // Keep the runner's Unix socket within the Darwin path-length limit.
  const root = await mkdtemp("/tmp/matrix-instructions-");
  try { await run(await realpath(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function isolationEnvironment(homePath: string) {
  return { HOME: homePath, PATH: "/usr/bin:/bin", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
}

async function withInferenceFixture(
  path: string,
  reply: (res: ServerResponse, index: number) => void,
  run: (origin: string, requests: ReadonlyArray<{ body: string; credential: string | undefined }>) => Promise<void>,
) {
  const requests: Array<{ body: string; credential: string | undefined }> = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== path) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      const credential = req.headers.authorization ?? req.headers["x-api-key"];
      if (requests.length >= 12) { res.writeHead(429).end(); return; }
      requests.push({ body, credential: typeof credential === "string" ? credential : undefined });
      reply(res, requests.length);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an isolated TCP listener");
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function completeCodexResponse(res: ServerResponse, index: number) {
  const item = {
    type: "message", id: `msg_fixture_${index}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: fixtureAnswer, annotations: [] }],
  };
  const response = { id: `resp_fixture_${index}`, status: "completed", output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [
    { type: "response.created", response: { id: response.id, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

async function runCodex(input: {
  binary: string; homePath: string; codexHome: string; root: ResolvedChatExecutionRoot;
  sessionId: string; prompt: string; providerThreadId?: string;
}) {
  const eventPath = codexProviderEventPath(input.homePath, input.sessionId);
  const launch = buildAgentLaunch({
    agent: "codex", codexExecutable: input.binary, cwd: input.root.primaryWorkspaceRoot,
    providerEventPath: eventPath, providerThreadId: input.providerThreadId,
    model: "gpt-5.6-sol", prompt: input.prompt, approvalPolicy: "never",
    sandbox: { enabled: true, mode: "read-only" },
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...isolationEnvironment(input.homePath), CODEX_HOME: input.codexHome,
      OPENAI_API_KEY: fixtureKey, MATRIX_CODEX_STARTUP_TIMEOUT_MS: "5000" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", chunk => { if (stderr.length < 2_048) stderr += String(chunk).slice(0, 2_048); });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  const stop = setTimeout(() => child.kill("SIGTERM"), 10_000);
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    const events = await vi.waitFor(async () => {
      const contents = await readFile(eventPath, "utf8");
      const events = contents.trim().split("\n").map(line => JSON.parse(line));
      expect(events.at(-1)?.type).toMatch(/^turn\.(?:completed|failed|aborted)$/);
      return events;
    }, { timeout: 8_000 });
    child.stdin.end();
    expect(await closed, stderr).toBe(0);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(JSON.stringify(events)).toContain(fixtureAnswer);
    const threadId: unknown = events.find(event => event.type === "thread.started")?.thread_id;
    expect(threadId).toEqual(expect.any(String));
    if (typeof threadId !== "string") throw new Error("Provider thread identity missing");
    return threadId;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    clearTimeout(stop);
    clearTimeout(forceStop);
  }
}

// Explicit published-binary lane, like tests/scope-runtime/codex-published-binary.test.ts.
// Never discover or use an authenticated binary/profile from the developer's PATH.
const codexBinary = process.env.CODEX_CONTRACT_BINARY;
describe.runIf(Boolean(codexBinary))("published Codex through the Matrix project launch boundary", () => {
  it("reads only the selected Git checkout's native instructions and resumes that checkout's thread", async () => {
    if (!codexBinary || !isAbsolute(codexBinary)) throw new Error("Set CODEX_CONTRACT_BINARY to the absolute published binary path");
    await isolatedFixture(async (homePath) => {
      const version = await exec(codexBinary, ["--version"], { env: isolationEnvironment(homePath), timeout: 5_000 });
      expect(version.stdout.trim()).toBe(`codex-cli ${CODEX_VERIFIED_VERSION}`);
      const projects = createProjectManager({ homePath });
      const worktrees = createWorktreeManager({
        homePath,
        runCommand(command, args, options) {
          if (command !== "git" || !options.cwd) throw new Error("Expected Git in a fixture checkout");
          return git(options.cwd, ...args);
        },
      });
      const a = await projects.createProject({ mode: "scratch", name: "Project A", slug: "a", ownerScope });
      const b = await projects.createProject({ mode: "scratch", name: "Project B", slug: "b", ownerScope });
      if (!a.ok || !b.ok) throw new Error("Project fixture creation failed");
      await git(homePath, "init", "-b", "main");
      await writeFile(join(homePath, "AGENTS.md"), parentMarker);
      for (const project of [a.project, b.project]) await git(project.localPath, "init", "-b", "main");
      await writeFile(join(a.project.localPath, "AGENTS.md"), primaryMarker);
      await writeFile(join(a.project.localPath, "CLAUDE.md"), claudeMarker);
      await writeFile(join(b.project.localPath, "AGENTS.md"), siblingMarker);
      await git(a.project.localPath, "add", "AGENTS.md", "CLAUDE.md");
      await git(a.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture");
      const worktree = await worktrees.createWorktree({ projectSlug: a.project.slug, branch: "fixture", createBranch: true, ownerScope });
      if (!worktree.ok) throw new Error("Worktree fixture creation failed");
      await writeFile(join(worktree.worktree.path, "AGENTS.md"), ignoredMarker);
      await writeFile(join(worktree.worktree.path, "AGENTS.override.md"), worktreeMarker);
      const resolver = createChatExecutionRootResolver({ homePath, projects, worktrees });
      const primary = await resolver.resolve(owner, { kind: "project", projectId: a.project.id });
      const selected = await resolver.resolve(owner, { kind: "worktree", projectId: a.project.id, worktreeId: worktree.worktree.id });
      expect(selected.fingerprint).not.toBe(primary.fingerprint);
      await expect(resolver.resolve(owner, {
        kind: "worktree", projectId: b.project.id, worktreeId: worktree.worktree.id,
      })).rejects.toThrow();

      await withInferenceFixture("/v1/responses", completeCodexResponse, async (origin, requests) => {
        const codexHome = join(homePath, "fixture-codex-home");
        await mkdir(codexHome);
        await writeFile(join(codexHome, "config.toml"), [
          'model_provider = "fixture"', 'web_search = "disabled"', 'check_for_update_on_startup = false',
          "[features]", "plugins = false", "[analytics]", "enabled = false",
          "[model_providers.fixture]", 'name = "Fixture"', `base_url = "${origin}/v1"`,
          'wire_api = "responses"', 'env_key = "OPENAI_API_KEY"', "request_max_retries = 0",
          "stream_max_retries = 0", "supports_websockets = false",
        ].join("\n"));
        const base = { binary: codexBinary, homePath, codexHome };
        const primaryThread = await runCodex({ ...base, root: primary, sessionId: "sess_primary", prompt: "Primary checkout fixture turn." });
        const worktreeThread = await runCodex({ ...base, root: selected, sessionId: "sess_worktree", prompt: "Worktree fixture turn." });
        expect(worktreeThread).not.toBe(primaryThread);
        const revalidated = await resolver.revalidate(owner, selected);
        await expect(runCodex({ ...base, root: revalidated, sessionId: "sess_resumed",
          providerThreadId: worktreeThread, prompt: "Worktree fixture continuation." })).resolves.toBe(worktreeThread);

        expect(requests).toHaveLength(3);
        expect(requests.map(({ credential }) => credential)).toEqual(Array(3).fill(`Bearer ${fixtureKey}`));
        const [primaryRequest, worktreeRequest, resumedRequest] = requests.map(({ body }) => body);
        expect(primaryRequest).toContain(primaryMarker);
        expect(primaryRequest).not.toContain(worktreeMarker);
        expect(worktreeRequest).toContain(worktreeMarker);
        expect(resumedRequest).toContain(worktreeMarker);
        for (const body of [worktreeRequest, resumedRequest]) expect(body).not.toContain(primaryMarker);
        for (const { body } of requests) {
          for (const marker of [ignoredMarker, claudeMarker, siblingMarker, parentMarker]) expect(body).not.toContain(marker);
        }
      });
    });
  }, 35_000);
});

const claudeBinary = process.env.CLAUDE_CONTRACT_BINARY;
describe.runIf(Boolean(claudeBinary))("published native Claude through the Matrix Chat adapter", () => {
  it("suppresses project instruction discovery in the production launch while the project-source control reads it", async () => {
    if (!claudeBinary || !isAbsolute(claudeBinary)) throw new Error("Set CLAUDE_CONTRACT_BINARY to the absolute published binary path");
    await isolatedFixture(async (homePath) => {
      const pins = await readFile(new URL("../../distro/customer-vps/host-bin/matrix-install-tool-pack", import.meta.url), "utf8");
      const pin = pins.match(/^CLAUDE_CODE_VERSION="(\d+\.\d+\.\d+)"$/m)?.[1];
      expect(pin).toBeDefined();
      const version = await exec(claudeBinary, ["--version"], { env: isolationEnvironment(homePath), timeout: 5_000 });
      expect(version.stdout.trim()).toBe(`${pin} (Claude Code)`);
      const projectPath = join(homePath, "fixture-project");
      await mkdir(projectPath);
      await git(projectPath, "init", "-b", "main");
      await writeFile(join(projectPath, "CLAUDE.md"), claudeMarker);
      await writeFile(join(projectPath, "AGENTS.md"), primaryMarker);
      await withInferenceFixture("/v1/messages", res => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Fixture captured the request" } }));
      }, async (origin, requests) => {
        for (const { sources, agentsOnly } of [
          { sources: "", agentsOnly: false },
          { sources: "project", agentsOnly: false },
          { sources: "", agentsOnly: true },
        ]) {
          if (agentsOnly) await rename(join(projectPath, "CLAUDE.md"), join(projectPath, "claude-fixture.txt"));
          const adapter = createClaudeChatProviderAdapter({
            homePath,
            resolveCredentialEnv: async () => ({
              ...isolationEnvironment(homePath), CLAUDE_CONFIG_DIR: join(homePath, "fixture-claude-config"),
              ANTHROPIC_API_KEY: fixtureKey, ANTHROPIC_BASE_URL: origin,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
            }),
            spawnFn(_command, args, options) {
              const index = args.indexOf("--setting-sources");
              expect(args[index + 1]).toBe("");
              expect(options.cwd).toBe(projectPath);
              const launchArgs = [...args];
              launchArgs[index + 1] = sources;
              return spawn(claudeBinary, launchArgs, { ...options, stdio: ["pipe", "pipe", "pipe"] });
            },
          });
          const before = requests.length;
          for await (const _event of adapter.start({
            owner, chatId: "chat_project_claude", turnId: "cturn_project_claude", runId: "run_project_claude",
            prompt: "Return the fixture answer.", parts: [{ type: "text", text: "Return the fixture answer." }],
            selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-6" },
            interactionMode: "default", permissionMode: "supervised", executionRoot: projectPath,
            signal: AbortSignal.timeout(10_000),
          })) { /* Drain adapter output, including the deliberate synthetic inference failure. */ }
          const captured = requests.slice(before);
          expect(captured.length).toBeGreaterThan(0);
          expect(captured.every(({ credential }) => credential === fixtureKey || credential === `Bearer ${fixtureKey}`)).toBe(true);
          const received = captured.map(({ body }) => body).join("\n");
          expect(received).not.toContain(primaryMarker);
          if (sources === "project") expect(received).toContain(claudeMarker);
          else expect(received).not.toContain(claudeMarker);
        }
      });
    });
  }, 30_000);
});
