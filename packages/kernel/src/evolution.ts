import { execFileSync } from "node:child_process";
import type { HookInput, HookOutput } from "./hooks.js";

export const PROTECTED_FILE_PATTERNS: RegExp[] = [
  /constitution\.md$/,
  /CLAUDE\.md$/,
  /packages\/kernel\/src\//,
  /packages\/gateway\/src\//,
  /tests\//,
  /package\.json$/,
  /tsconfig\.json$/,
  /vitest\.config\.ts$/,
  /pnpm-lock\.yaml$/,
  /pnpm-workspace\.yaml$/,
  /\.specify\//,
];

export function createProtectedFilesHook(
  _homePath: string,
): (input: HookInput) => Promise<HookOutput> {
  return async (input: HookInput): Promise<HookOutput> => {
    if (input.tool_name !== "Write" && input.tool_name !== "Edit") {
      return {};
    }

    const toolInput = input.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path;
    if (!filePath || typeof filePath !== "string") {
      return {};
    }

    for (const pattern of PROTECTED_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          hookSpecificOutput: { permissionDecision: "deny" },
          systemMessage: `Blocked write to protected file: ${filePath}. This file is protected from modification by the evolver.`,
        };
      }
    }

    return {};
  };
}

export interface WatchdogConfig {
  homePath: string;
  revertWindowMs?: number;
  onRevert?: (commitMessage: string) => void;
}

export interface Watchdog {
  markEvolution(): void;
  lastEvolutionTime(): number;
  revertLastCommit(): boolean;
  stop(): void;
}

export function createWatchdog(config: WatchdogConfig): Watchdog {
  const { homePath, revertWindowMs = 30000, onRevert } = config;
  let evolutionTimestamp = 0;

  function markEvolution(): void {
    evolutionTimestamp = Date.now();
  }

  function lastEvolutionTime(): number {
    return evolutionTimestamp;
  }

  function revertLastCommit(): boolean {
    if (evolutionTimestamp === 0) return false;

    const elapsed = Date.now() - evolutionTimestamp;
    if (elapsed > revertWindowMs) return false;

    try {
      const commitCount = execFileSync(
        "git",
        ["rev-list", "--count", "HEAD"],
        { cwd: homePath, encoding: "utf-8" },
      ).trim();

      if (parseInt(commitCount, 10) <= 1) return false;

      const commitMsg = execFileSync(
        "git",
        ["log", "-1", "--format=%s"],
        { cwd: homePath, encoding: "utf-8" },
      ).trim();

      execFileSync(
        "git",
        ["reset", "--hard", "HEAD~1"],
        { cwd: homePath, stdio: "ignore" },
      );

      onRevert?.(commitMsg);
      return true;
    } catch {
      return false;
    }
  }

  function stop(): void {
    evolutionTimestamp = 0;
  }

  return { markEvolution, lastEvolutionTime, revertLastCommit, stop };
}
