import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_ENV } from "./git-env.js";

const execAsync = promisify(execFile);

export interface GitAutoCommitConfig {
  homePath: string;
  intervalMs?: number;
}

export interface AutoCommitResult {
  committed: boolean;
  message: string;
  filesChanged: number;
}

export interface GitAutoCommit {
  start(): void;
  stop(): void;
  commitIfChanged(): Promise<AutoCommitResult>;
}

export interface SnapshotResult {
  success: boolean;
  tag: string;
  commit?: string;
}

export interface SnapshotEntry {
  name: string;
  tag: string;
  commit: string;
  date: string;
}

export interface SnapshotManager {
  create(name: string): Promise<SnapshotResult>;
  list(): Promise<SnapshotEntry[]>;
}

export interface HistoryEntry {
  commit: string;
  message: string;
  date: string;
  author: string;
}

export interface HistoryOptions {
  limit?: number;
  offset?: number;
}

export interface RestoreResult {
  success: boolean;
  message: string;
}

export interface FileHistory {
  log(path: string, options?: HistoryOptions): Promise<HistoryEntry[]>;
  diff(path: string, commit: string): Promise<string>;
  restore(path: string, commit: string): Promise<RestoreResult>;
}

async function git(homePath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync("git", args, {
    cwd: homePath,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

export function createGitAutoCommit(config: GitAutoCommitConfig): GitAutoCommit {
  const { homePath, intervalMs = 600_000 } = config;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function commitIfChanged(): Promise<AutoCommitResult> {
    const porcelain = await git(homePath, "status", "--porcelain");
    if (!porcelain) {
      return { committed: false, message: "", filesChanged: 0 };
    }

    const changedFiles = porcelain.split("\n").filter((l) => l.trim().length > 0);
    const count = changedFiles.length;
    const topFiles = changedFiles
      .slice(0, 3)
      .map((l) => l.replace(/^.{2}\s/, "").trim())
      .join(", ");

    const summary = count <= 3
      ? `Auto-save: ${topFiles}`
      : `Auto-save: ${count} files (${topFiles})`;

    await git(homePath, "add", "-A");
    await git(homePath, "commit", "-m", summary);

    return { committed: true, message: summary, filesChanged: count };
  }

  return {
    start() {
      timer = setInterval(() => {
        commitIfChanged().catch(() => {});
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    commitIfChanged,
  };
}

export function createSnapshotManager(homePath: string): SnapshotManager {
  return {
    async create(name: string): Promise<SnapshotResult> {
      const tag = `snapshot/${name}`;

      // Commit any uncommitted changes first
      const porcelain = await git(homePath, "status", "--porcelain");
      if (porcelain) {
        await git(homePath, "add", "-A");
        await git(homePath, "commit", "-m", `Snapshot: ${name}`);
      }

      const commit = await git(homePath, "rev-parse", "HEAD");
      await git(homePath, "tag", "-a", tag, "-m", name);

      return { success: true, tag, commit };
    },

    async list(): Promise<SnapshotEntry[]> {
      let output: string;
      try {
        output = await git(
          homePath,
          "tag",
          "-l",
          "snapshot/*",
          "--format=%(refname:short)|%(objectname:short)|%(*objectname:short)|%(creatordate:iso-strict)",
        );
      } catch {
        return [];
      }

      if (!output) return [];

      return output.split("\n").filter(Boolean).map((line) => {
        const [tag, tagObj, commitObj, date] = line.split("|");
        const commit = commitObj || tagObj;
        const name = tag.replace("snapshot/", "");
        return { name, tag, commit, date };
      });
    },
  };
}

export function createFileHistory(homePath: string): FileHistory {
  return {
    async log(path: string, options?: HistoryOptions): Promise<HistoryEntry[]> {
      const { limit = 20, offset = 0 } = options ?? {};

      const output = await git(
        homePath,
        "log",
        "--follow",
        `--format=%H|%s|%aI|%an`,
        `--skip=${offset}`,
        `-n`,
        `${limit}`,
        "--",
        path,
      );

      if (!output) return [];

      return output.split("\n").filter(Boolean).map((line) => {
        const [commit, message, date, author] = line.split("|");
        return { commit, message, date, author };
      });
    },

    async diff(path: string, commit: string): Promise<string> {
      const output = await git(homePath, "show", `${commit}`, "--", path);
      return output;
    },

    async restore(path: string, commit: string): Promise<RestoreResult> {
      try {
        const content = await git(homePath, "show", `${commit}:${path}`);
        const fullPath = join(homePath, path);
        writeFileSync(fullPath, content, "utf-8");

        await git(homePath, "add", path);
        await git(
          homePath,
          "commit",
          "-m",
          `Restored ${path} from ${commit.slice(0, 7)}`,
        );

        return { success: true, message: `Restored ${path}` };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : "Restore failed",
        };
      }
    },
  };
}
