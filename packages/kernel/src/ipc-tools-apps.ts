/**
 * Matrix IPC Security audit, app management, history, and search tools.
 *
 * Extracted from ./ipc-server.ts (Phase 1-A4). Pure move: no logic changes.
 * Each builder receives the shared tool factory so the SDK stays
 * dynamically imported exactly once by the composition root.
 */

import type { tool as createSdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { MatrixDB } from './db.js';
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { listConversationSummaries, getConversationMessages } from "./conversation-history.js";
import { join } from "node:path";
import { searchMemories } from "./memory-search.js";
import { z } from "zod/v4";

export interface IpcToolDeps {
  db: MatrixDB;
  homePath?: string;
}

type SdkToolFactory = typeof createSdkTool;

export function createAppsTools(
  deps: IpcToolDeps,
  tool: SdkToolFactory,
) {
  const { db, homePath } = deps;
  return [
        tool(
          "security_audit",
          "Run a security audit on this Matrix OS instance. Returns findings with severity levels and remediation guidance.",
          {},
          async () => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot audit (no home path)" }] };
            }
            const { runSecurityAudit } = await import("./security/audit.js");
            const report = await runSecurityAudit(homePath);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
            };
          },
        ),
  
        tool(
          "publish_app",
          "Publish an app to the Matrix OS App Store. Validates the manifest, creates a registry entry, and returns the public URL.",
          {
            app_name: z.string().describe("Name of the app directory under ~/apps/"),
            description: z.string().optional().describe("Override description for store listing"),
            tags: z.array(z.string()).optional().describe("Tags for the app listing"),
          },
          async ({ app_name, description, tags }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot publish (no home path)" }] };
            }
            try {
              const { validateForPublish, preparePublishPayload } = await import("@matrix-os/gateway/app-publish");
              const { loadHandle } = await import("./identity.js");
              const appDir = join(homePath, "apps", app_name);
              if (!existsSync(appDir)) {
                return { content: [{ type: "text" as const, text: `App "${app_name}" not found in ~/apps/` }] };
              }
  
              const validation = validateForPublish(appDir);
              if (!validation.valid) {
                return { content: [{ type: "text" as const, text: `Publish validation failed: ${validation.error}` }] };
              }
  
              const handle = loadHandle(homePath);
              const authorId = handle ? `@${handle.handle}` : "@local";
              const payload = preparePublishPayload(appDir, authorId);
              if (!payload) {
                return { content: [{ type: "text" as const, text: "Failed to prepare publish payload" }] };
              }
  
              if (description) payload.description = description;
              if (tags) payload.tags = JSON.stringify(tags);
  
              const url = `matrix-os.com/store/${authorId}/${payload.slug}`;
              return {
                content: [{
                  type: "text" as const,
                  text: `App "${payload.name}" ready to publish!\nSlug: ${payload.slug}\nVersion: ${payload.version}\nURL: ${url}\n\nPayload: ${JSON.stringify(payload, null, 2)}`,
                }],
              };
            } catch (e) {
              return { content: [{ type: "text" as const, text: `Publish error: ${e instanceof Error ? e.message : String(e)}` }] };
            }
          },
        ),
  
        tool(
          "app_data",
          "Read or write persistent data for any app. Data is stored in ~/data/{app}/{key}.json. Use this to interact with app state from chat (e.g., add a task to a task manager, read notes, update expenses).",
          {
            action: z.enum(["read", "write", "list"]).describe("read: get data, write: set data, list: show all keys for an app"),
            app: z.string().describe("App name/slug (e.g., 'task-manager', 'notes', 'expense-tracker')"),
            key: z.string().optional().describe("Data key (required for read/write)"),
            value: z.string().optional().describe("JSON string to write (required for write action)"),
          },
          async ({ action, app, key, value }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot access app data (no home path)" }] };
            }
            const { appDataHandler } = await import("./app-data.js");
            return appDataHandler(homePath, { action, app, key, value });
          },
        ),
  
        tool(
          "fork_app",
          "Fork a public app from the store into this user's ~/apps/ directory. Creates a writable copy with forked_from attribution.",
          {
            source_path: z.string().describe("Path to the source app files"),
            slug: z.string().describe("Slug name for the forked app"),
            author: z.string().describe("Original author handle (e.g. @hamed)"),
            version: z.string().optional().describe("Version being forked (default: 1.0.0)"),
          },
          async ({ source_path, slug, author, version }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot fork (no home path)" }] };
            }
            try {
              const { forkApp } = await import("@matrix-os/gateway/app-fork");
              const result = forkApp({
                sourceDir: source_path,
                homePath,
                slug,
                author,
                version: version ?? "1.0.0",
              });
              if (!result.success) {
                return { content: [{ type: "text" as const, text: `Fork failed: ${result.error}` }] };
              }
              return {
                content: [{
                  type: "text" as const,
                  text: `Forked "${slug}" from ${author} to ${result.targetDir}\nYou can now modify this app freely.`,
                }],
              };
            } catch (e) {
              return { content: [{ type: "text" as const, text: `Fork error: ${e instanceof Error ? e.message : String(e)}` }] };
            }
          },
        ),
  
        tool(
          "install_app",
          "Install an app from the store into this user's ~/apps/ directory. Creates a copy without fork attribution.",
          {
            source_path: z.string().describe("Path to the source app files"),
            slug: z.string().describe("Slug name for the installed app"),
          },
          async ({ source_path, slug }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot install (no home path)" }] };
            }
            try {
              const { installApp } = await import("@matrix-os/gateway/app-fork");
              const result = installApp({ sourceDir: source_path, homePath, slug });
              if (!result.success) {
                return { content: [{ type: "text" as const, text: `Install failed: ${result.error}` }] };
              }
              return {
                content: [{
                  type: "text" as const,
                  text: `Installed "${slug}" to ${result.targetDir}`,
                }],
              };
            } catch (e) {
              return { content: [{ type: "text" as const, text: `Install error: ${e instanceof Error ? e.message : String(e)}` }] };
            }
          },
        ),
  
        tool(
          "conversation_history",
          "List recent conversation summaries, or fetch full conversation by session ID. Use 'list' to see what conversations happened, 'get' to read a specific one.",
          {
            action: z.enum(["list", "get"]),
            sessionId: z.string().optional().describe("Session ID for 'get' action"),
            limit: z.number().optional().describe("Max results for 'list' (default 10)"),
          },
          async ({ action, sessionId, limit }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Conversation history not available (no home path)" }] };
            }
  
            if (action === "list") {
              const summaries = listConversationSummaries(homePath, limit);
              if (summaries.length === 0) {
                return { content: [{ type: "text" as const, text: "No conversation history yet." }] };
              }
              return { content: [{ type: "text" as const, text: JSON.stringify(summaries, null, 2) }] };
            }
  
            if (!sessionId) {
              return { content: [{ type: "text" as const, text: "Error: sessionId required for 'get'" }] };
            }
            const messages = getConversationMessages(homePath, sessionId);
            if (messages === null) {
              return { content: [{ type: "text" as const, text: `No conversation found: ${sessionId}` }] };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }] };
          },
        ),
  
        tool(
          "memory_search",
          "Search long-term memory and conversation history for relevant context. Use this when you need to recall information from previous sessions.",
          {
            query: z.string().describe("Search query"),
            scope: z.enum(["all", "memories", "conversations"]).optional()
              .describe("Search scope (default: all)"),
            limit: z.number().optional().describe("Max results (default: 10)"),
          },
          async ({ query, scope, limit }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Memory search not available (no home path)" }] };
            }
            const results = searchMemories(db, homePath, { query, scope, limit });
            if (results.length === 0) {
              return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
          },
        ),
  
        tool(
          "qmd_search",
          "Semantic search across knowledge files, skills, conversation summaries, and apps using QMD. Returns ranked results with snippets. Use this to find relevant context from the user's files.",
          {
            query: z.string().describe("Search query (natural language)"),
            collection: z.enum(["knowledge", "skills", "summaries", "conversations", "apps"]).optional()
              .describe("Filter to a specific collection (default: search all)"),
            limit: z.number().optional().describe("Max results (default: 5)"),
          },
          async ({ query, collection, limit }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "QMD not available (no home path)" }] };
            }
            try {
              const args = ["search", query, "--json"];
              if (collection) { args.push("-c", collection); }
              args.push("-n", String(limit ?? 5));
  
              const env = {
                ...process.env,
                XDG_CACHE_HOME: join(homePath, "system", "qmd"),
                XDG_CONFIG_HOME: join(homePath, "system", "qmd"),
              };
  
              const result = execFileSync("qmd", args, {
                encoding: "utf-8",
                timeout: 5000,
                env,
              }).trim();
  
              const parsed = JSON.parse(result || "[]");
              if (parsed.length === 0) {
                return { content: [{ type: "text" as const, text: "No results found." }] };
              }
  
              const formatted = parsed.map((r: { file: string; score: number; snippet: string; title: string }) =>
                `**${r.file}** (score: ${r.score})\n${r.title}\n${r.snippet}`,
              ).join("\n---\n");
  
              return { content: [{ type: "text" as const, text: formatted }] };
            } catch (err: unknown) {
              console.warn("[ipc] QMD search failed:", err instanceof Error ? err.message : String(err));
              return { content: [{ type: "text" as const, text: "QMD search unavailable (not installed or not indexed)" }] };
            }
          },
        ),
  ];
}
