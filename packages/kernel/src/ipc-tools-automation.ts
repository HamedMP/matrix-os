/**
 * Matrix IPC File sync, cron, and conversation tools.
 *
 * Extracted from ./ipc-server.ts (Phase 1-A4). Pure move: no logic changes.
 * Each builder receives the shared tool factory so the SDK stays
 * dynamically imported exactly once by the composition root.
 */

import type { tool as createSdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { MatrixDB } from './db.js';
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod/v4";

export interface IpcToolDeps {
  db: MatrixDB;
  homePath?: string;
}

type SdkToolFactory = typeof createSdkTool;

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const SAFE_GIT_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SCP_LIKE_GIT_REMOTE_URL =
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:\.git)?$/;


export function isSafeGitRemoteName(remoteName: string): boolean {
  return SAFE_GIT_REMOTE_NAME.test(remoteName);
}


export function isSafeGitRemoteUrl(remoteUrl: string): boolean {
  if (remoteUrl === "" || remoteUrl.startsWith("-") || /[\0\r\n]/.test(remoteUrl)) {
    return false;
  }
  if (SAFE_SCP_LIKE_GIT_REMOTE_URL.test(remoteUrl)) {
    return true;
  }
  try {
    const parsed = new URL(remoteUrl);
    return parsed.protocol === "https:" || parsed.protocol === "ssh:";
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn("[ipc] Failed to parse git remote URL:", err instanceof Error ? err.message : String(err));
    }
    return false;
  }
}

export function createAutomationTools(
  deps: IpcToolDeps,
  tool: SdkToolFactory,
) {
  const { db, homePath } = deps;
  return [
        tool(
          "sync_files",
          "Manage git sync for the user's home directory. Commit local changes, push to remote, pull from remote, add/remove remotes, or check status.",
          {
            action: z.enum(["status", "commit", "push", "pull", "add_remote", "remove_remote"]),
            message: z.string().optional().describe("Commit message (for commit action)"),
            remote_name: z.string().optional().describe("Remote name (default: origin)"),
            remote_url: z.string().optional().describe("Remote URL (for add_remote)"),
          },
          async ({ action, message, remote_name, remote_url }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Sync not available (no home path)" }] };
            }
            async function git(...args: string[]): Promise<string> {
              const { stdout } = await execAsync("git", args, { cwd: homePath! });
              return stdout.trim();
            }
            function readSafeRemoteName(): string | null {
              const remote = remote_name ?? "origin";
              if (!isSafeGitRemoteName(remote)) {
                return null;
              }
              return remote;
            }
            try {
              switch (action) {
                case "status": {
                  const porcelain = await git("status", "--porcelain");
                  const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch((err: unknown) => {
                    console.warn("[ipc] Could not read git branch:", err instanceof Error ? err.message : String(err));
                    return "unknown";
                  });
                  const remotes = await git("remote", "-v").catch((err: unknown) => {
                    console.warn("[ipc] Could not read git remotes:", err instanceof Error ? err.message : String(err));
                    return "none";
                  });
                  return { content: [{ type: "text" as const, text: `Branch: ${branch}\nClean: ${porcelain === ""}\nRemotes:\n${remotes}\n${porcelain ? `Changes:\n${porcelain}` : ""}` }] };
                }
                case "commit": {
                  const porcelain = await git("status", "--porcelain");
                  if (porcelain === "") {
                    return { content: [{ type: "text" as const, text: "Nothing to commit -- working tree clean" }] };
                  }
                  await git("add", "-A");
                  await git("commit", "-m", message ?? "sync");
                  return { content: [{ type: "text" as const, text: `Committed: ${message ?? "sync"}` }] };
                }
                case "push": {
                  const remote = readSafeRemoteName();
                  if (!remote) {
                    return { content: [{ type: "text" as const, text: "Invalid git remote name" }] };
                  }
                  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
                  await git("push", "-u", "--", remote, branch);
                  return { content: [{ type: "text" as const, text: `Pushed to ${remote}/${branch}` }] };
                }
                case "pull": {
                  const remote = readSafeRemoteName();
                  if (!remote) {
                    return { content: [{ type: "text" as const, text: "Invalid git remote name" }] };
                  }
                  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
                  await git("pull", "--", remote, branch);
                  return { content: [{ type: "text" as const, text: `Pulled from ${remote}/${branch}` }] };
                }
                case "add_remote": {
                  if (!remote_name || !remote_url) {
                    return { content: [{ type: "text" as const, text: "add_remote requires remote_name and remote_url" }] };
                  }
                  if (!isSafeGitRemoteName(remote_name)) {
                    return { content: [{ type: "text" as const, text: "Invalid git remote name" }] };
                  }
                  if (!isSafeGitRemoteUrl(remote_url)) {
                    return { content: [{ type: "text" as const, text: "Invalid git remote URL" }] };
                  }
                  await git("remote", "add", "--", remote_name, remote_url);
                  return { content: [{ type: "text" as const, text: `Added remote: ${remote_name} -> ${remote_url}` }] };
                }
                case "remove_remote": {
                  if (!remote_name) {
                    return { content: [{ type: "text" as const, text: "remove_remote requires remote_name" }] };
                  }
                  if (!isSafeGitRemoteName(remote_name)) {
                    return { content: [{ type: "text" as const, text: "Invalid git remote name" }] };
                  }
                  await git("remote", "remove", "--", remote_name);
                  return { content: [{ type: "text" as const, text: `Removed remote: ${remote_name}` }] };
                }
              }
            } catch (e) {
              return { content: [{ type: "text" as const, text: `Sync error: ${e instanceof Error ? e.message : String(e)}` }] };
            }
          },
        ),
  
        tool(
          "manage_cron",
          "Manage scheduled cron jobs. Use 'add' to create reminders/recurring tasks, 'remove' to delete, 'list' to view all.",
          {
            action: z.enum(["add", "remove", "list"]),
            name: z.string().optional().describe("Job name (required for add)"),
            message: z.string().optional().describe("Message to deliver when job fires (required for add)"),
            schedule: z.string().optional().describe("JSON schedule object, e.g. {\"type\":\"interval\",\"intervalMs\":3600000} or {\"type\":\"cron\",\"cron\":\"0 9 * * *\"} or {\"type\":\"once\",\"at\":\"2026-03-01T09:00:00Z\"}"),
            job_id: z.string().optional().describe("Job ID (required for remove)"),
            channel: z.string().optional().describe("Target channel for delivery (telegram, discord, slack, whatsapp)"),
            chat_id: z.string().optional().describe("Target chat ID for delivery"),
          },
          async ({ action, name, message, schedule, job_id, channel, chat_id }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cron not available (no home path)" }] };
            }
            const cronPath = join(homePath, "system", "cron.json");
  
            function readJobs(): unknown[] {
              if (!existsSync(cronPath)) return [];
              try {
                return JSON.parse(readFileSync(cronPath, "utf-8"));
              } catch (err: unknown) {
                console.warn("[ipc] Could not read cron jobs:", err instanceof Error ? err.message : String(err));
                return [];
              }
            }
  
            function writeJobs(jobs: unknown[]) {
              void writeFile(cronPath, JSON.stringify(jobs, null, 2) + "\n").catch((err: unknown) => {
                console.warn("[ipc] Could not persist cron jobs:", err instanceof Error ? err.message : String(err));
              });
            }
  
            switch (action) {
              case "list": {
                const jobs = readJobs();
                return { content: [{ type: "text" as const, text: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : "No cron jobs" }] };
              }
              case "add": {
                if (!name || !message || !schedule) {
                  return { content: [{ type: "text" as const, text: "add requires name, message, and schedule" }] };
                }
                let parsed: unknown;
                try {
                  parsed = JSON.parse(schedule);
                } catch (err: unknown) {
                  console.warn("[ipc] Invalid cron schedule JSON:", err instanceof Error ? err.message : String(err));
                  return { content: [{ type: "text" as const, text: "Invalid schedule JSON" }] };
                }
                const job = {
                  id: `cron_${randomUUID().slice(0, 8)}`,
                  name,
                  message,
                  schedule: parsed,
                  target: channel ? { channel, chatId: chat_id } : undefined,
                  createdAt: new Date().toISOString(),
                };
                const jobs = readJobs();
                jobs.push(job);
                writeJobs(jobs);
                return { content: [{ type: "text" as const, text: `Created cron job: ${job.id} (${name})` }] };
              }
              case "remove": {
                if (!job_id) {
                  return { content: [{ type: "text" as const, text: "remove requires job_id" }] };
                }
                const jobs = readJobs();
                const filtered = jobs.filter((j: any) => j.id !== job_id);
                if (filtered.length === jobs.length) {
                  return { content: [{ type: "text" as const, text: `Job ${job_id} not found` }] };
                }
                writeJobs(filtered);
                return { content: [{ type: "text" as const, text: `Removed cron job: ${job_id}` }] };
              }
            }
          },
        ),
  
        tool(
          "new_conversation",
          "Create a new conversation session. Returns the session ID. Use this when the user wants to start a fresh chat.",
          {
            channel: z.string().optional().describe("Optional channel prefix (e.g. 'telegram')"),
          },
          async ({ channel }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot create conversation (no home path)" }] };
            }
            const convDir = join(homePath, "system", "conversations");
            mkdirSync(convDir, { recursive: true });
            const uuid = randomUUID();
            const id = channel ? `${channel}:${uuid}` : uuid;
            const now = Date.now();
            const conv = { id, createdAt: now, updatedAt: now, messages: [] };
            await writeFile(join(convDir, `${id}.json`), JSON.stringify(conv, null, 2));
            return { content: [{ type: "text" as const, text: `Created conversation: ${id}` }] };
          },
        ),
  
        tool(
          "search_conversations",
          "Search across all conversation sessions for messages matching a query. Use this to find context from previous conversations when the user references something discussed before.",
          {
            query: z.string().describe("Search query (case-insensitive substring match)"),
            limit: z.number().optional().describe("Max results to return (default 10)"),
          },
          async ({ query, limit }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot search conversations (no home path)" }] };
            }
            const convDir = join(homePath, "system", "conversations");
            if (!existsSync(convDir)) {
              return { content: [{ type: "text" as const, text: "No conversations found" }] };
            }
  
            const maxResults = limit ?? 10;
            const lowerQuery = query.toLowerCase();
            const results: Array<{
              sessionId: string;
              messageIndex: number;
              role: string;
              preview: string;
              timestamp: number;
            }> = [];
  
            const files = readdirSync(convDir).filter((f: string) => f.endsWith(".json"));
            for (const f of files) {
              try {
                const data = JSON.parse(readFileSync(join(convDir, f), "utf-8"));
                const messages = data.messages ?? [];
                for (let i = 0; i < messages.length; i++) {
                  const msg = messages[i];
                  if (msg.content?.toLowerCase().includes(lowerQuery)) {
                    results.push({
                      sessionId: data.id ?? f.replace(".json", ""),
                      messageIndex: i,
                      role: msg.role,
                      preview: msg.content.length > 100
                        ? msg.content.slice(0, 100) + "..."
                        : msg.content,
                      timestamp: msg.timestamp ?? 0,
                    });
                  }
                }
              } catch (err: unknown) {
                console.warn("[ipc] Skipping malformed conversation file:", err instanceof Error ? err.message : String(err));
              }
            }
  
            results.sort((a, b) => b.timestamp - a.timestamp);
            const limited = results.slice(0, maxResults);
  
            return {
              content: [{
                type: "text" as const,
                text: limited.length > 0
                  ? JSON.stringify(limited, null, 2)
                  : `No messages matching "${query}" found`,
              }],
            };
          },
        ),
  ];
}
