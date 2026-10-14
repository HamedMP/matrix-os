// End-to-end handoff against a fake gateway that performs the real work
// locally: uploads land in a temporary Matrix home, remote scripts run with
// real git, and projects/worktrees are created the way the gateway does.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HandoffApiError, type HandoffGateway, type ProviderInstance } from "../../packages/sync-client/src/cli/handoff/gateway-api.js";
import type { MatrixProject } from "../../packages/sync-client/src/cli/handoff/project-match.js";
import { runHandoff, type HandoffDeps, type HandoffInput } from "../../packages/sync-client/src/cli/handoff/run-handoff.js";
import { assertGatewayRunBody, git, TEST_GIT_ENV } from "./handoff-test-git.js";

const exec = promisify(execFile);

const CODEX: ProviderInstance = {
  id: "codex_default",
  driverKind: "codex",
  displayName: "Codex",
  availability: "available",
  models: [{ id: "gpt-5.6-sol", availability: "available" }, { id: "gpt-6-sol", availability: "available" }, { id: "gpt-6-old", availability: "unavailable" }],
  setupActions: [],
  supports: { interactionModes: ["default", "review"], permissionModes: ["supervised", "auto_accept_edits", "auto", "full_access"] },
  defaultSelection: { model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }] },
};
const CLAUDE_NEEDS_LOGIN: ProviderInstance = {
  id: "claude_code_default",
  driverKind: "claude_code",
  displayName: "Claude Code",
  availability: "auth_required",
  models: [],
  setupActions: [{ kind: "foreground_terminal", command: "claude" }],
};

let root: string;
let home: string;
let origin: string;
let local: string;

interface FakeState {
  projects: (MatrixProject & { createdBy?: string })[];
  failNextTurn?: boolean;
  githubAuth: boolean;
  chats: { id: string; body: unknown }[];
  turns: { chatId: string; body: Record<string, unknown> }[];
  calls: string[];
}

function fakeGateway(state: FakeState): HandoffGateway {
  return {
    async listProjects() {
      state.calls.push("listProjects");
      return state.projects;
    },
    async createProject(body) {
      state.calls.push(`createProject:${String(body.mode)}`);
      const slug = String(body.slug);
      const existing = state.projects.find((project) => project.slug === slug);
      if (existing && existing.createdBy === body.clientRequestId) return existing;
      if (existing) throw new HandoffApiError("conflict", 409, "slug_conflict");
      if (body.mode === "github") {
        if (!state.githubAuth) throw new HandoffApiError("auth", 424, "github_auth_required");
        const localPath = join(home, "projects", slug, "repo");
        await mkdir(join(home, "projects", slug), { recursive: true });
        await git(root, "clone", "-q", origin, localPath);
        const project = { id: `proj_${slug}`, slug, name: String(body.name), kind: "github", localPath, github: { owner: "acme", repo: "app" }, createdBy: String(body.clientRequestId) };
        state.projects.push(project);
        return project;
      }
      const localPath = await realpath(join(home, String(body.path)));
      const project = { id: `proj_${slug}`, slug, name: String(body.name), kind: "folder", localPath, createdBy: String(body.clientRequestId) };
      state.projects.push(project);
      return project;
    },
    async listWorktrees() {
      return [];
    },
    async createWorktree(slug, branch) {
      state.calls.push(`createWorktree:${branch}`);
      const project = state.projects.find((candidate) => candidate.slug === slug)!;
      const id = `wt_${createHash("sha256").update(`${slug}:${branch}`).digest("hex").slice(0, 16)}`;
      const path = join(home, "worktrees", slug, id);
      const listed = await git(project.localPath, "worktree", "list", "--porcelain");
      if (!listed.includes(`worktree ${path}`)) {
        await mkdir(join(home, "worktrees", slug), { recursive: true });
        await git(project.localPath, "worktree", "add", "-q", "--", path, branch);
      }
      return { id, path, currentBranch: branch };
    },
    async providerCatalog() {
      return [CODEX, CLAUDE_NEEDS_LOGIN];
    },
    async createChat(body) {
      const id = `chat_${state.chats.length + 1}`;
      state.chats.push({ id, body });
      return { id, revision: 0 };
    },
    async startTurn(chatId, body) {
      if (state.failNextTurn) {
        state.failNextTurn = false;
        throw new HandoffApiError("unavailable", 503, "request_failed");
      }
      state.turns.push({ chatId, body });
    },
    async run(command) {
      assertGatewayRunBody(command);
      const [bin, ...args] = command.command;
      const { stdout, stderr } = await exec(bin!, args, { cwd: home, env: { ...process.env, ...TEST_GIT_ENV }, timeout: 60_000 });
      return { stdout, stderr, exitCode: 0 };
    },
    async uploadFile(localPath, remotePath) {
      state.calls.push("upload");
      const target = join(home, remotePath);
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(localPath, target);
    },
  };
}

function deps(state: FakeState, extra: Partial<HandoffDeps> = {}): HandoffDeps {
  return {
    gateway: fakeGateway(state),
    discoverTranscript: async () => null,
    importTranscript: async () => ({ chatId: "chat_imported" }),
    now: () => new Date("2026-10-14T12:00:00Z"),
    log: () => undefined,
    ...extra,
  };
}

function input(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return { cwd: local, agent: "codex", brief: "Finish the parser refactor.", history: "none", gatewayUrl: "https://app.matrix-os.com", account: "user:user_1", ...overrides };
}

const yes = async () => true;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "handoff-flow-")));
  home = join(root, "home");
  await mkdir(home);
  origin = join(root, "origin.git");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  local = join(root, "app");
  await git(root, "clone", "-q", origin, local);
  await writeFile(join(local, "parser.ts"), "v1\n");
  await git(local, "add", ".");
  await git(local, "commit", "-q", "-m", "init");
  await git(local, "push", "-q", "origin", "HEAD:main");
  // The fake GitHub remote: inspection reads origin's URL, clone uses the bare repo.
  await git(local, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  await git(local, "checkout", "-q", "-b", "feat/parser");
  await writeFile(join(local, "parser.ts"), "v2\n");
  await git(local, "commit", "-qam", "refactor step 1");
  await writeFile(join(local, "parser.ts"), "v3 wip\n");
  await writeFile(join(local, ".env"), "TOKEN=secret\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runHandoff", () => {
  it("previews without any remote writes and refuses a stale approval token", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const { preview, result } = await runHandoff(input(), deps(state), async () => false);
    expect(result).toBeNull();
    expect(state.calls).toEqual(["listProjects"]);
    expect(preview.project).toMatchObject({ action: "create_github", slug: "app", url: "https://github.com/acme/app" });
    expect(preview.snapshot.withheldPaths).toEqual([".env"]);
    expect(preview.approvalToken).toMatch(/^202610141200\.[a-f0-9]{64}$/);

    // Same scope → same token, even on a later clock.
    const again = await runHandoff(input(), deps(state, { now: () => new Date("2026-10-14T13:00:00Z") }), async () => false);
    expect(again.preview.approvalToken.split(".")[1]).toBe(preview.approvalToken.split(".")[1]);

    await writeFile(join(local, "parser.ts"), "v4 changed after preview\n");
    await expect(runHandoff(input({ approvalToken: preview.approvalToken }), deps(state), yes)).rejects.toMatchObject({ code: "scope_changed" });
    expect(state.calls.filter((call) => call !== "listProjects")).toEqual([]);
  });

  it("creates the GitHub project, worktree and a project-bound Chat with the brief", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const { preview } = await runHandoff(input(), deps(state), async () => false);
    const { result } = await runHandoff(input({ approvalToken: preview.approvalToken }), deps(state), yes);

    expect(result).toMatchObject({ projectSlug: "app", branch: "feat/parser", usedSideBranch: false, chatId: "chat_1" });
    expect(result!.executionRoot).toMatchObject({ kind: "worktree", projectId: "proj_app" });
    expect(result!.url).toBe("https://app.matrix-os.com/?launch=__chat__&chat=chat_1");
    const onVm = await runHandoff(input({ gatewayUrl: "https://app.matrix-os.com/vm/alice" }), deps(state, { now: () => new Date("2026-10-14T12:10:00Z") }), yes);
    expect(onVm.result!.url).toBe(`https://app.matrix-os.com/vm/alice/?launch=__chat__&chat=${onVm.result!.chatId}`);
    expect(await readFile(join(result!.checkoutPath, "parser.ts"), "utf8")).toBe("v3 wip\n");
    await expect(readFile(join(result!.checkoutPath, ".env"))).rejects.toThrow();
    expect(await git(result!.checkoutPath, "log", "-1", "--format=%s")).toBe("refactor step 1");

    expect(state.chats[0]!.body).toMatchObject({ projectId: "proj_app", currentSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" } });
    const turn = state.turns[0]!.body;
    expect(turn).toMatchObject({ baseRevision: 0, interactionMode: "default", permissionMode: "supervised", executionRoot: result!.executionRoot });
    const text = (turn.parts as { text: string }[])[0]!.text;
    expect(text).toContain("Finish the parser refactor.");
    expect(text).toContain("Withheld secret-looking files (not copied): .env");
    expect(String(turn.clientRequestId)).toMatch(/^req_[A-Za-z0-9_-]+$/);
    expect(await readFile(join(home, "data", "matrix-handoff"), "utf8").catch((error: NodeJS.ErrnoException) => error.code)).toBe("EISDIR");
    expect(await git(state.projects[0]!.localPath, "for-each-ref", "refs/matrix-handoff/")).toBe("");
  });

  it("reuses the project and worktree on a second handoff of the same branch", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const first = await runHandoff(input(), deps(state), yes);
    // Commit the WIP on Matrix so the second handoff sees a clean, older branch.
    await git(first.result!.checkoutPath, "checkout", "--", ".");
    await writeFile(join(local, "parser.ts"), "v5\n");
    await git(local, "commit", "-qam", "refactor step 2");
    const second = await runHandoff(input({ brief: "Keep going." }), deps(state, { now: () => new Date("2026-10-14T12:30:00Z") }), yes);
    expect(state.calls.filter((call) => call.startsWith("createProject"))).toEqual(["createProject:github"]);
    expect(second.result).toMatchObject({ projectSlug: "app", branch: "feat/parser", usedSideBranch: false, checkoutPath: first.result!.checkoutPath });
    expect(await git(second.result!.checkoutPath, "log", "-1", "--format=%s")).toBe("refactor step 2");
  });

  it("lands on a side branch when the Matrix worktree has uncommitted work", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const first = await runHandoff(input(), deps(state), yes);
    // Someone keeps working in the Matrix worktree without committing.
    await writeFile(join(first.result!.checkoutPath, "parser.ts"), "edited on matrix\n");
    const second = await runHandoff(input(), deps(state, { now: () => new Date("2026-10-14T12:45:00Z") }), yes);
    expect(second.result).toMatchObject({ usedSideBranch: true, branch: "handoff/feat/parser-202610141245" });
    expect(await readFile(join(first.result!.checkoutPath, "parser.ts"), "utf8")).toBe("edited on matrix\n");
    expect(await readFile(join(second.result!.checkoutPath, "parser.ts"), "utf8")).toBe("v3 wip\n");
    const text = (state.turns[1]!.body.parts as { text: string }[])[0]!.text;
    expect(text).toContain("landed on `handoff/feat/parser-202610141245`");
  });

  it("uploads the repository as a folder project when Matrix has no GitHub login", async () => {
    const state: FakeState = { projects: [], githubAuth: false, chats: [], turns: [], calls: [] };
    const { result } = await runHandoff(input(), deps(state), yes);
    const rootCommit = await git(local, "rev-list", "--max-parents=0", "HEAD");
    const slug = `app-${rootCommit.slice(0, 7)}`;
    expect(state.calls.filter((call) => call.startsWith("createProject"))).toEqual(["createProject:github", "createProject:folder"]);
    expect(result).toMatchObject({ projectSlug: slug, branch: "feat/parser", executionRoot: { kind: "project", projectId: `proj_${slug}` } });
    expect(await readFile(join(home, "projects", slug, "parser.ts"), "utf8")).toBe("v3 wip\n");
    expect(await git(join(home, "projects", slug), "remote", "get-url", "origin")).toBe("https://github.com/acme/app");

    // A second run finds the folder project by its root-commit slug.
    await git(join(home, "projects", slug), "checkout", "--", ".");
    const second = await runHandoff(input(), deps(state, { now: () => new Date("2026-10-14T12:50:00Z") }), yes);
    expect(second.result!.projectSlug).toBe(slug);
    expect(state.calls.filter((call) => call.startsWith("createProject"))).toHaveLength(2);
  });

  it("uses a requested model and rejects one the agent does not offer", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const { result } = await runHandoff(input({ model: "gpt-6-sol" }), deps(state), yes);
    expect(result).not.toBeNull();
    expect(state.turns[0]!.body).toMatchObject({ selection: { instanceId: "codex_default", model: "gpt-6-sol" } });
    for (const model of ["gpt-6.1-sol", "gpt-6-old"]) {
      await expect(runHandoff(input({ model }), deps(state), yes)).rejects.toMatchObject({ code: "invalid_model" });
    }
  });

  it("binds approval to the destination computer and account", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const { preview } = await runHandoff(input(), deps(state), async () => false);
    for (const other of [{ account: "user:user_2" }, { gatewayUrl: "https://app.matrix-os.com/vm/bob" }]) {
      await expect(runHandoff(input({ ...other, approvalToken: preview.approvalToken }), deps(state), yes)).rejects.toMatchObject({ code: "scope_changed" });
    }
    expect(state.calls.some((call) => call.startsWith("createProject") || call === "upload")).toBe(false);
  });

  it("lets the same approval finish after a failure that followed project creation", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [], failNextTurn: true };
    const { preview } = await runHandoff(input(), deps(state), async () => false);
    await expect(runHandoff(input({ approvalToken: preview.approvalToken }), deps(state), yes)).rejects.toBeInstanceOf(HandoffApiError);
    expect(state.projects).toHaveLength(1);
    const retry = await runHandoff(input({ approvalToken: preview.approvalToken }), deps(state), yes);
    expect(retry.result).toMatchObject({ projectSlug: "app", branch: "feat/parser", usedSideBranch: false });
    expect(await readFile(join(retry.result!.checkoutPath, "parser.ts"), "utf8")).toBe("v3 wip\n");
    expect(state.turns).toHaveLength(1);
  });

  it("uploads instead when the fallback slug is needed and Matrix has no GitHub login", async () => {
    const state: FakeState = {
      projects: [{ id: "proj_other", slug: "app", name: "other", kind: "github", localPath: "/elsewhere", github: { owner: "someone", repo: "else" } }],
      githubAuth: false, chats: [], turns: [], calls: [],
    };
    const { result } = await runHandoff(input(), deps(state), yes);
    expect(state.calls.filter((call) => call.startsWith("createProject"))).toEqual(["createProject:github", "createProject:github", "createProject:folder"]);
    expect(result!.projectSlug).toMatch(/^app-[a-f0-9]{7}$/);
  });

  it("stops before uploading when the agent is not signed in on Matrix", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    await expect(runHandoff(input({ agent: "claude" }), deps(state), yes)).rejects.toMatchObject({
      code: "agent_not_ready",
      message: expect.stringContaining("run `claude`"),
    });
    expect(state.calls).toEqual(["listProjects"]);
  });

  it("imports the discovered transcript and mentions it in the first message", async () => {
    const state: FakeState = { projects: [], githubAuth: true, chats: [], turns: [], calls: [] };
    const transcriptPath = join(root, "session.jsonl");
    await writeFile(transcriptPath, "{}\n");
    const imported: string[] = [];
    const { preview, result } = await runHandoff(input({ history: "auto" }), deps(state, {
      discoverTranscript: async () => ({ path: transcriptPath, harness: "claude", bytes: 3, modifiedMs: 1, capture: { size: 3, dev: 1n, ino: 2n } }),
      importTranscript: async (choice, title) => {
        expect(choice.capture).toEqual({ size: 3, dev: 1n, ino: 2n });
        imported.push(`${choice.path}|${title}`);
        return { chatId: "chat_history" };
      },
    }), yes);
    expect(preview.transcript?.path).toBe(transcriptPath);
    expect(imported).toEqual([`${transcriptPath}|app · feat/parser (local history)`]);
    expect(result!.transcriptChatId).toBe("chat_history");
    expect((state.turns[0]!.body.parts as { text: string }[])[0]!.text).toContain("chat_history");
  });
});
