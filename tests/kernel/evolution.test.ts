import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createProtectedFilesHook,
  createWatchdog,
  PROTECTED_FILE_PATTERNS,
  type Watchdog,
} from "../../packages/kernel/src/evolution.js";
import type { HookInput } from "../../packages/kernel/src/hooks.js";

function makeHookInput(
  toolName: string,
  toolInput: unknown = {},
): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: "test-session",
  };
}

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "evolution-test-"));
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

function gitCommit(dir: string, file: string, content: string, message: string) {
  writeFileSync(join(dir, file), content);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
}

describe("PROTECTED_FILE_PATTERNS", () => {
  it("exports a non-empty array of patterns", () => {
    expect(PROTECTED_FILE_PATTERNS).toBeInstanceOf(Array);
    expect(PROTECTED_FILE_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("createProtectedFilesHook", () => {
  let homePath: string;
  let hook: ReturnType<typeof createProtectedFilesHook>;

  beforeEach(() => {
    homePath = tmpHome();
    hook = createProtectedFilesHook(homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  // --- Deny cases ---

  it("denies Write to constitution.md", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, ".specify/memory/constitution.md"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Edit to constitution.md", async () => {
    const input = makeHookInput("Edit", {
      file_path: join(homePath, ".specify/memory/constitution.md"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to kernel source files", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/packages/kernel/src/kernel.ts",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to gateway source files", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/packages/gateway/src/server.ts",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to CLAUDE.md", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/CLAUDE.md",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to package.json", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/package.json",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to vitest config", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/vitest.config.ts",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to tsconfig", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/tsconfig.json",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies Write to test files", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/tests/kernel/hooks.test.ts",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // --- Allow cases ---

  it("allows Write to shell components", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/shell/src/components/NewWidget.tsx",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows Write to shell hooks", async () => {
    const input = makeHookInput("Write", {
      file_path: "/Users/someone/dev/matrix-os/shell/src/hooks/useCustom.ts",
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows Write to theme.json", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, "system/theme.json"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows Write to custom agent definitions", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, "agents/custom/my-agent.md"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows Write to knowledge files", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, "agents/knowledge/new-strategy.md"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows Write to apps", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, "apps/my-app.html"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows Write to modules", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, "modules/my-mod/index.js"),
    });
    const result = await hook(input);
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  // --- Non-file tools ---

  it("passes through non-Write/Edit tools", async () => {
    const input = makeHookInput("Bash", { command: "ls" });
    const result = await hook(input);
    expect(result).toEqual({});
  });

  it("passes through Read tool", async () => {
    const input = makeHookInput("Read", {
      file_path: "/Users/someone/dev/matrix-os/packages/kernel/src/kernel.ts",
    });
    const result = await hook(input);
    expect(result).toEqual({});
  });

  // --- Edge cases ---

  it("handles missing file_path gracefully", async () => {
    const input = makeHookInput("Write", {});
    const result = await hook(input);
    expect(result).toEqual({});
  });

  it("includes reason in systemMessage when denying", async () => {
    const input = makeHookInput("Write", {
      file_path: join(homePath, ".specify/memory/constitution.md"),
    });
    const result = await hook(input);
    expect(result.systemMessage).toContain("protected");
  });
});

describe("createWatchdog", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
    gitInit(homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("markEvolution records a timestamp", () => {
    const wd = createWatchdog({ homePath });
    wd.markEvolution();
    expect(wd.lastEvolutionTime()).toBeGreaterThan(0);
    wd.stop();
  });

  it("lastEvolutionTime returns 0 when no evolution recorded", () => {
    const wd = createWatchdog({ homePath });
    expect(wd.lastEvolutionTime()).toBe(0);
    wd.stop();
  });

  it("revertLastCommit reverts when evolution happened recently", () => {
    const wd = createWatchdog({ homePath, revertWindowMs: 60000 });

    gitCommit(homePath, "evolve.txt", "evolved content", "evolver change");

    wd.markEvolution();
    const reverted = wd.revertLastCommit();
    expect(reverted).toBe(true);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: homePath, encoding: "utf-8" });
    expect(log).toContain("initial");
    expect(log).not.toContain("evolver change");
    wd.stop();
  });

  it("revertLastCommit returns false when no recent evolution", () => {
    const wd = createWatchdog({ homePath });

    gitCommit(homePath, "file.txt", "content", "normal change");

    const reverted = wd.revertLastCommit();
    expect(reverted).toBe(false);
    wd.stop();
  });

  it("revertLastCommit returns false when evolution is outside revert window", () => {
    const wd = createWatchdog({ homePath, revertWindowMs: 1 });

    gitCommit(homePath, "evolve.txt", "evolved", "evolver change");

    wd.markEvolution();

    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const reverted = wd.revertLastCommit();
    expect(reverted).toBe(false);
    wd.stop();
  });

  it("revertLastCommit calls onRevert callback", () => {
    const onRevert = vi.fn();
    const wd = createWatchdog({ homePath, revertWindowMs: 60000, onRevert });

    gitCommit(homePath, "evolve.txt", "evolved", "evolver change");

    wd.markEvolution();
    wd.revertLastCommit();
    expect(onRevert).toHaveBeenCalledWith(expect.stringContaining("evolver change"));
    wd.stop();
  });

  it("stop clears internal state", () => {
    const wd = createWatchdog({ homePath });
    wd.markEvolution();
    wd.stop();
    expect(wd.lastEvolutionTime()).toBe(0);
  });

  it("handles revert when only initial commit exists", () => {
    const wd = createWatchdog({ homePath, revertWindowMs: 60000 });
    wd.markEvolution();
    const reverted = wd.revertLastCommit();
    // Only one commit -- can't revert further
    expect(reverted).toBe(false);
    wd.stop();
  });
});
