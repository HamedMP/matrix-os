import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  safetyGuardHook,
  updateStateHook,
  logActivityHook,
  createGitSnapshotHook,
  preCompactHook,
} from "../../packages/kernel/src/hooks.js";
import type { HookInput } from "../../packages/kernel/src/hooks.js";

function makeHookInput(
  toolName: string,
  toolInput: unknown = {},
  toolResponse: unknown = "ok",
): HookInput {
  return {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    session_id: "test-session",
  };
}

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "hooks-test-"));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function gitInit(dir: string) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "init.txt"), "initial");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

describe("safetyGuardHook", () => {
  it("denies rm -rf /", async () => {
    const input = makeHookInput("Bash", { command: "rm -rf /" });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies rm -rf on home directory", async () => {
    const input = makeHookInput("Bash", { command: "rm -rf ~/" });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows safe bash commands", async () => {
    const input = makeHookInput("Bash", { command: "ls -la" });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("denies writes to protected system paths", async () => {
    const input = makeHookInput("Write", {
      file_path: "/etc/passwd",
    });
    const result = await safetyGuardHook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("updateStateHook", () => {
  it("returns a valid hook response", async () => {
    const input = makeHookInput("Write", {
      file_path: "/home/user/matrixos/apps/todo.html",
    });
    const result = await updateStateHook(input);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});

describe("logActivityHook", () => {
  it("returns a valid hook response", async () => {
    const input = makeHookInput("Bash", { command: "npm install" });
    const result = await logActivityHook(input);
    expect(result).toBeDefined();
  });
});

describe("createGitSnapshotHook", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
    gitInit(homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("commits staged changes before file mutation", async () => {
    writeFileSync(join(homePath, "new-file.txt"), "content");
    const hook = createGitSnapshotHook(homePath);
    const input = makeHookInput("Write", { file_path: join(homePath, "apps/todo.html") });
    await hook(input);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: homePath, encoding: "utf-8" });
    expect(log).toContain("snapshot: pre-mutation");
  });

  it("skips commit when nothing to commit", async () => {
    const hook = createGitSnapshotHook(homePath);
    const input = makeHookInput("Write", { file_path: join(homePath, "apps/todo.html") });
    const result = await hook(input);
    expect(result).toBeDefined();

    const log = execFileSync("git", ["log", "--oneline"], { cwd: homePath, encoding: "utf-8" });
    expect(log).not.toContain("snapshot");
  });

  it("does not crash when not a git repo", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "no-git-"));
    const hook = createGitSnapshotHook(nonGitDir);
    const input = makeHookInput("Write", { file_path: join(nonGitDir, "file.txt") });
    const result = await hook(input);
    expect(result).toEqual({});
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it("only triggers on Write and Edit tools", async () => {
    writeFileSync(join(homePath, "change.txt"), "data");
    const hook = createGitSnapshotHook(homePath);
    const input = makeHookInput("Bash", { command: "ls" });
    await hook(input);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: homePath, encoding: "utf-8" });
    expect(log).not.toContain("snapshot");
  });
});

describe("preCompactHook", () => {
  it("returns a valid hook response", async () => {
    const input: HookInput = {
      hook_event_name: "PreCompact",
      session_id: "test-session",
    };
    const result = await preCompactHook(input);
    expect(result).toBeDefined();
  });
});
