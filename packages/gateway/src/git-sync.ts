import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

export interface GitStatus {
  clean: boolean;
  ahead: number;
  behind: number;
  branch: string;
  hasRemote: boolean;
}

export interface GitResult {
  success: boolean;
  message: string;
}

export interface GitSync {
  status(): Promise<GitStatus>;
  commit(message: string): Promise<GitResult>;
  push(remote?: string): Promise<GitResult>;
  pull(remote?: string): Promise<GitResult>;
  addRemote(name: string, url: string): Promise<GitResult>;
  removeRemote(name: string): Promise<GitResult>;
}

export function createGitSync(homePath: string): GitSync {
  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execAsync("git", args, { cwd: homePath });
    return stdout.trim();
  }

  return {
    async status(): Promise<GitStatus> {
      const porcelain = await git("status", "--porcelain");
      const clean = porcelain === "";

      let branch = "main";
      try {
        branch = await git("rev-parse", "--abbrev-ref", "HEAD");
      } catch {}

      let ahead = 0;
      let behind = 0;
      let hasRemote = false;

      try {
        const remotes = await git("remote");
        hasRemote = remotes.length > 0;
        if (hasRemote) {
          await git("fetch", "--quiet");
          const tracking = await git("rev-parse", "--abbrev-ref", `${branch}@{upstream}`);
          if (tracking) {
            const counts = await git("rev-list", "--left-right", "--count", `${tracking}...HEAD`);
            const [b, a] = counts.split(/\s+/).map(Number);
            behind = b;
            ahead = a;
          }
        }
      } catch {}

      return { clean, ahead, behind, branch, hasRemote };
    },

    async commit(message: string): Promise<GitResult> {
      const porcelain = await git("status", "--porcelain");
      if (porcelain === "") {
        return { success: false, message: "Nothing to commit" };
      }

      await git("add", "-A");
      await git("commit", "-m", message);
      return { success: true, message: "Committed" };
    },

    async push(remote = "origin"): Promise<GitResult> {
      try {
        const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
        await git("push", "-u", remote, branch);
        return { success: true, message: `Pushed to ${remote}/${branch}` };
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async pull(remote = "origin"): Promise<GitResult> {
      try {
        const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
        await git("pull", remote, branch);
        return { success: true, message: `Pulled from ${remote}/${branch}` };
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async addRemote(name: string, url: string): Promise<GitResult> {
      try {
        await git("remote", "add", name, url);
        return { success: true, message: `Added remote ${name}` };
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async removeRemote(name: string): Promise<GitResult> {
      try {
        await git("remote", "remove", name);
        return { success: true, message: `Removed remote ${name}` };
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
