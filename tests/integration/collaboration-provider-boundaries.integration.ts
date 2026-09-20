/**
 * S00 / T002 — Codex and Claude provider boundary probes for spec 124.
 *
 * Runs under `bun run test:integration` (vitest.integration.config.ts), never
 * under the unit glob. Every live probe is gated on an explicit fixture env
 * variable and reports itself as UNRUN with the missing fixture named when
 * that variable is absent. Skip is not pass: evidence/providers.md lists each
 * probe and its last observed outcome. Tokens are read from env only and are
 * never written to disk or logs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION,
  SCOPE_RUNTIME_CODEX_HARNESS_VERSION,
} from "../../packages/scope-runtime/src/worker";
import {
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "../../packages/scope-runtime/src/profile";

const REPO_ROOT = resolve(__dirname, "../..");
const PROBE_TIMEOUT_MS = 120_000;

const fixtures = {
  anthropicApiKey: process.env.COLLABORATION_PROBE_ANTHROPIC_API_KEY,
  claudeOauthToken: process.env.COLLABORATION_PROBE_CLAUDE_OAUTH_TOKEN,
  openaiApiKey: process.env.COLLABORATION_PROBE_OPENAI_API_KEY,
  codexAuthJsonPath: process.env.COLLABORATION_PROBE_CODEX_AUTH_JSON,
} as const;

const unrun = (fixture: string): string => `unrun: fixture ${fixture} missing`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Codex reads credentials only from `$CODEX_HOME/auth.json`; there is no in-memory
 * mechanism. The copy therefore lives for one probe in a 0o700 per-run directory as a
 * 0o600 file and is removed in afterEach, afterAll and on process exit/SIGINT/SIGTERM so
 * an aborted run cannot leave the token on disk. Residual risk is recorded in
 * evidence/providers.md.
 */
const credentialDirs = new Set<string>();
function removeCredentialDirs(): void {
  for (const dir of credentialDirs) rmSync(dir, { recursive: true, force: true });
  credentialDirs.clear();
}
function onSignal(signal: NodeJS.Signals): void {
  removeCredentialDirs();
  process.off(signal, onSignal);
  process.kill(process.pid, signal);
}
process.once("exit", removeCredentialDirs);
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
afterAll(removeCredentialDirs);

function ephemeralCodexHome(authJsonPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-cred-"));
  credentialDirs.add(dir);
  tempDirs.push(dir);
  writeFileSync(join(dir, "auth.json"), readFileSync(authJsonPath), { mode: 0o600, flag: "wx" });
  return dir;
}

/** A Codex `exec --json` run counts as authenticated success only with a completed turn event. */
function codexTurnCompleted(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    if (!line.startsWith("{")) return false;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string } };
      return event.type === "turn.completed" || event.item?.type === "agent_message";
    } catch {
      return false;
    }
  });
}

/** A Claude SDK run counts as authenticated success only with a non-error `result` message. */
async function claudeRunSucceeded(run: AsyncIterable<{ type: string; subtype?: string; is_error?: boolean }>): Promise<boolean> {
  let ok = false;
  for await (const message of run) {
    if (message.type === "result") ok = message.subtype === "success" && message.is_error !== true;
  }
  return ok;
}

function gitRepoWithWorktree(): { projectRoot: string; worktreeRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "collab-probe-"));
  tempDirs.push(base);
  const projectRoot = join(base, "project");
  mkdirSync(projectRoot);
  const run = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "probe@example.invalid", GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "probe@example.invalid" } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  run(projectRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(join(projectRoot, "README.md"), "probe\n");
  run(projectRoot, ["add", "."]);
  run(projectRoot, ["commit", "-q", "-m", "init"]);
  const worktreeRoot = join(base, "worktree");
  run(projectRoot, ["worktree", "add", "-q", "-b", "probe", worktreeRoot]);
  return { projectRoot, worktreeRoot };
}

function codexBinary(): string | null {
  const candidates = ["/opt/matrix/runtime/node/bin/codex", "codex"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

async function loadAgentSdk(): Promise<typeof import("@anthropic-ai/claude-agent-sdk")> {
  const require = createRequire(join(REPO_ROOT, "packages/kernel/package.json"));
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  return (await import(entry)) as typeof import("@anthropic-ai/claude-agent-sdk");
}

describe("S00 provider boundary probes: pinned versions (always run)", () => {
  it("records the exact harness and SDK versions the shared adapters are pinned to", () => {
    const kernelPackage = JSON.parse(readFileSync(join(REPO_ROOT, "packages/kernel/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const sdkVersion = kernelPackage.dependencies["@anthropic-ai/claude-agent-sdk"];
    expect(sdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCOPE_RUNTIME_CODEX_HARNESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCOPE_RUNTIME_PROFILE_ID).toBe("scope-runtime-chat-v1");
    expect(SCOPE_RUNTIME_PROFILE_VERSION).toBeGreaterThanOrEqual(2);
    expect(SCOPE_RUNTIME_PROFILE_DIGEST).toMatch(/^[a-f0-9]{64}$/);
  });

  it("characterizes the shared Codex invocation as sandboxed exec with JSON output", () => {
    const worker = readFileSync(join(REPO_ROOT, "packages/scope-runtime/src/worker.ts"), "utf8");
    expect(worker).toContain('"--sandbox", "read-only"');
    expect(worker).toContain('"exec"');
    expect(worker).toContain('"--json"');
    expect(worker).toContain('cwd: "/workspace"');
  });
});

describe("S00 provider boundary probes: Claude API execution", () => {
  it.skipIf(!fixtures.anthropicApiKey)(
    `Claude API run writes only inside the selected worktree root (${unrun("COLLABORATION_PROBE_ANTHROPIC_API_KEY")})`,
    async () => {
      const { projectRoot, worktreeRoot } = gitRepoWithWorktree();
      const sdk = await loadAgentSdk();
      const outcome: string[] = [];
      const run = sdk.query({
        prompt: "Create a file named probe.txt containing the single word probe in the current directory, then stop.",
        options: {
          cwd: worktreeRoot,
          model: "claude-haiku-4-5-20251001",
          permissionMode: "bypassPermissions",
          allowedTools: ["Write"],
          maxTurns: 4,
          env: { ...process.env, ANTHROPIC_API_KEY: fixtures.anthropicApiKey },
        },
      });
      for await (const message of run) outcome.push(message.type);
      expect(outcome).toContain("result");
      expect(existsSync(join(worktreeRoot, "probe.txt"))).toBe(true);
      expect(existsSync(join(projectRoot, "probe.txt"))).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!fixtures.anthropicApiKey)(
    `Claude API tool approval callback can deny a tool and the run still terminates (${unrun("COLLABORATION_PROBE_ANTHROPIC_API_KEY")})`,
    async () => {
      const { worktreeRoot } = gitRepoWithWorktree();
      const sdk = await loadAgentSdk();
      let denied = 0;
      const run = sdk.query({
        prompt: "Create a file named denied.txt in the current directory.",
        options: {
          cwd: worktreeRoot,
          model: "claude-haiku-4-5-20251001",
          allowedTools: ["Write"],
          maxTurns: 3,
          env: { ...process.env, ANTHROPIC_API_KEY: fixtures.anthropicApiKey },
          canUseTool: async () => {
            denied += 1;
            return { behavior: "deny", message: "denied by collaboration approval probe" };
          },
        },
      });
      const types: string[] = [];
      for await (const message of run) types.push(message.type);
      expect(types).toContain("result");
      expect(denied).toBeGreaterThan(0);
      expect(existsSync(join(worktreeRoot, "denied.txt"))).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!fixtures.anthropicApiKey)(
    `Claude API run stops promptly on cancellation (${unrun("COLLABORATION_PROBE_ANTHROPIC_API_KEY")})`,
    async () => {
      const { worktreeRoot } = gitRepoWithWorktree();
      const sdk = await loadAgentSdk();
      const controller = new AbortController();
      const run = sdk.query({
        prompt: "Count from 1 to 500, one number per line.",
        options: {
          cwd: worktreeRoot,
          model: "claude-haiku-4-5-20251001",
          maxTurns: 1,
          abortController: controller,
          env: { ...process.env, ANTHROPIC_API_KEY: fixtures.anthropicApiKey },
        },
      });
      const started = Date.now();
      let seen = 0;
      try {
        for await (const _message of run) {
          seen += 1;
          if (seen === 1) controller.abort();
        }
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(seen).toBeGreaterThanOrEqual(1);
      expect(Date.now() - started).toBeLessThan(60_000);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!fixtures.anthropicApiKey)(
    `Claude session resume with a changed root is observed and recorded (${unrun("COLLABORATION_PROBE_ANTHROPIC_API_KEY")})`,
    async () => {
      const { projectRoot, worktreeRoot } = gitRepoWithWorktree();
      const sdk = await loadAgentSdk();
      let sessionId: string | undefined;
      let firstSucceeded = false;
      const first = sdk.query({
        prompt: "Reply with the single word ready.",
        options: { cwd: worktreeRoot, model: "claude-haiku-4-5-20251001", maxTurns: 1, env: { ...process.env, ANTHROPIC_API_KEY: fixtures.anthropicApiKey } },
      });
      for await (const message of first) {
        if ("session_id" in message && typeof message.session_id === "string") sessionId = message.session_id;
        if (message.type === "result") firstSucceeded = message.subtype === "success" && message.is_error !== true;
      }
      expect(firstSucceeded).toBe(true);
      expect(sessionId).toBeTruthy();
      let resumedType: string | undefined;
      let resumeError: string | undefined;
      try {
        const second = sdk.query({
          prompt: "Reply with the single word resumed.",
          options: { cwd: projectRoot, resume: sessionId, model: "claude-haiku-4-5-20251001", maxTurns: 1, env: { ...process.env, ANTHROPIC_API_KEY: fixtures.anthropicApiKey } },
        });
        for await (const message of second) resumedType = message.type;
      } catch (error: unknown) {
        resumeError = error instanceof Error ? error.name : "UnknownError";
      }
      // Evidence, not a gate: record whether the SDK accepts a resume across roots so S09
      // can decide whether a fresh authorized continuation is mandatory or merely policy.
      console.info("[s00-probe] claude resume across roots", { resumedType, resumeError });
      expect(resumedType !== undefined || resumeError !== undefined).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("S00 provider boundary probes: Codex API execution", () => {
  it.skipIf(!fixtures.openaiApiKey || !codexBinary())(
    `Codex API run writes only inside the selected worktree root (${unrun("COLLABORATION_PROBE_OPENAI_API_KEY or codex binary")})`,
    () => {
      const { projectRoot, worktreeRoot } = gitRepoWithWorktree();
      const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
      tempDirs.push(codexHome);
      const result = spawnSync(codexBinary() as string, [
        "exec", "--json", "--sandbox", "workspace-write", "-C", worktreeRoot,
        "Create a file named probe.txt containing the single word probe in the current directory, then stop.",
      ], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: { ...process.env, OPENAI_API_KEY: fixtures.openaiApiKey, CODEX_HOME: codexHome } });
      console.info("[s00-probe] codex exec status", result.status);
      expect(result.status).toBe(0);
      expect(existsSync(join(worktreeRoot, "probe.txt"))).toBe(true);
      expect(existsSync(join(projectRoot, "probe.txt"))).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  it.skipIf(!fixtures.codexAuthJsonPath || !codexBinary())(
    `Codex native subscription auth used from a different CODEX_HOME completes an authenticated turn (${unrun("COLLABORATION_PROBE_CODEX_AUTH_JSON or codex binary")})`,
    () => {
      const { worktreeRoot } = gitRepoWithWorktree();
      const codexHome = ephemeralCodexHome(fixtures.codexAuthJsonPath as string);
      const result = spawnSync(codexBinary() as string, [
        "exec", "--json", "--sandbox", "read-only", "-C", worktreeRoot, "Reply with the single word ready.",
      ], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "" } });
      removeCredentialDirs();
      const authRejected = /unauthori[sz]ed|not logged in|login|401|403|invalid.*token/i.test(result.stderr ?? "");
      console.info("[s00-probe] codex subscription delegated request", { status: result.status, authRejected });
      // A delegated request is evidence of technical usability only when the provider
      // accepted it and a turn completed; a rejection or an auth error is a FAILED probe,
      // recorded as such in evidence/providers.md, never green.
      expect(authRejected, `codex rejected the delegated credential: ${result.stderr?.slice(0, 200)}`).toBe(false);
      expect(result.status).toBe(0);
      expect(codexTurnCompleted(result.stdout ?? "")).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("S00 provider boundary probes: Claude native subscription", () => {
  it.skipIf(!fixtures.claudeOauthToken)(
    `Claude subscription OAuth token used by a non-owner process completes an authenticated turn (${unrun("COLLABORATION_PROBE_CLAUDE_OAUTH_TOKEN")})`,
    async () => {
      const { worktreeRoot } = gitRepoWithWorktree();
      const sdk = await loadAgentSdk();
      // Any thrown error here (authentication included) fails the probe: it must never
      // read as a successful delegated request.
      const run = sdk.query({
        prompt: "Reply with the single word ready.",
        options: { cwd: worktreeRoot, model: "claude-haiku-4-5-20251001", maxTurns: 1, env: { ...process.env, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: fixtures.claudeOauthToken } },
      });
      const succeeded = await claudeRunSucceeded(run);
      console.info("[s00-probe] claude subscription delegated request", { succeeded });
      expect(succeeded).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );
});
