import { z } from "zod/v4";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MatrixDB } from "./db.js";
import { createTasksTools } from "./ipc-tools-tasks.js";
import { createWorkspaceTools } from "./ipc-tools-workspace.js";
import { createAutomationTools } from "./ipc-tools-automation.js";
import { createMemoryMediaTools } from "./ipc-tools-memory-media.js";
import { createAppsTools } from "./ipc-tools-apps.js";
import { createIntegrationsTools } from "./ipc-tools-integrations.js";
export { isSafeGitRemoteName, isSafeGitRemoteUrl } from "./ipc-tools-automation.js";
import {
  listTasks,
  claimTask,
  completeTask,
  failTask,
  sendMessage,
  readMessages,
  readState,
  createTask,
} from "./ipc.js";
import { loadSkillBody } from "./skills.js";
import { createMemoryStore } from "./memory.js";
import { createImageClient } from "./image-gen.js";
import { listConversationSummaries, getConversationMessages } from "./conversation-history.js";
import { searchMemories } from "./memory-search.js";
import { createUsageTracker } from "./usage.js";
import { getPersonaSuggestions, writeSetupPlan, SetupPlanSchema } from "./onboarding.js";
import { saveIdentity, deriveAiHandle } from "./identity.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { WebCache } from "./tools/web-cache.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool, type ApiKeys } from "./tools/web-search.js";
import {
  connectServiceHandler,
  callServiceHandler,
  describeServiceHandler,
  disconnectServiceHandler,
  listIntegrationInventoryHandler,
  listConnectedServicesHandler,
  syncServicesHandler,
  listCustomMcpServersHandler,
  describeCustomMcpServerHandler,
  callCustomMcpToolHandler,
} from "./tools/integrations.js";
import type { OsViewDesktopAddResult } from "@matrix-os/contracts";
const SAFE_GIT_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SCP_LIKE_GIT_REMOTE_URL =
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:\.git)?$/;

export interface OsViewAgentTools {
  listPlaceableApps(): Promise<Array<{ appId: string; name: string; path: string }>>;
  addAppToDesktop(appId: string): Promise<{ status: OsViewDesktopAddResult }>;
}

export async function createIpcServer(db: MatrixDB, homePath?: string, osViewTools?: OsViewAgentTools) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  return createSdkMcpServer({
    name: "matrix-os-ipc",
    tools: [
      ...createTasksTools({ db, homePath }, tool),


      ...createWorkspaceTools({ db, homePath }, tool),


      ...createAutomationTools({ db, homePath }, tool),


      ...createMemoryMediaTools({ db, homePath }, tool),


      // NOTE: "call" IPC tool removed -- telephony requires CallManager which lives
      // in the gateway process. The kernel runs as a separate process via Agent SDK,
      // so direct injection is not possible. Call control should route through the
      // gateway HTTP API (POST /api/voice/calls) in a future phase.

      ...createAppsTools({ db, homePath }, tool),


      ...(osViewTools ? [
        tool(
          "list_placeable_apps",
          "List exact installed app IDs that can be added to Desktop. Use only when the user asks to place an app on Desktop.",
          {},
          async () => ({
            content: [{ type: "text" as const, text: JSON.stringify(await osViewTools.listPlaceableApps()) }],
          }),
        ),
        tool(
          "add_app_to_desktop",
          "Add one installed app to Desktop after the user explicitly requests it. Pass an exact appId returned by list_placeable_apps; paths and owner IDs are not accepted.",
          { appId: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/) },
          async ({ appId }) => ({
            content: [{ type: "text" as const, text: JSON.stringify(await osViewTools.addAppToDesktop(appId)) }],
          }),
        ),
      ] : []),

      ...(await createWebTools(homePath, tool)),

      ...createIntegrationsTools({ db, homePath }, tool),

    ],
  });
}

async function createWebTools(homePath: string | undefined, tool: typeof import("@anthropic-ai/claude-agent-sdk").tool) {
  const webConfig = loadWebConfig(homePath);
  const cache = new WebCache({ defaultTtlMs: (webConfig.fetch.cacheTtlMinutes ?? 15) * 60_000 });
  const fetchTool = createWebFetchTool({
    cache,
    wrapContent: true,
    maxChars: webConfig.fetch.maxChars,
    firecrawlApiKey: webConfig.fetch.firecrawlApiKey,
  });
  const apiKeys: ApiKeys = {
    brave: webConfig.search.braveApiKey,
    perplexity: webConfig.search.perplexityApiKey,
    grok: webConfig.search.grokApiKey,
  };
  const searchTool = createWebSearchTool({ cache, apiKeys });

  return [
    tool(
      "web_fetch",
      "Fetch and extract content from a web page URL. Returns cleaned markdown text. Use for reading articles, documentation, or any public web page.",
      {
        url: z.string().describe("The URL to fetch (must be http or https)"),
        extract_mode: z.enum(["markdown", "text"]).optional().describe("Output format (default: markdown)"),
        max_chars: z.number().optional().describe("Max characters to return (default: 50000)"),
      },
      async ({ url, extract_mode, max_chars }) => {
        try {
          const result = await fetchTool.execute({
            url,
            extractMode: extract_mode,
            maxChars: max_chars,
          });
          return {
            content: [{
              type: "text" as const,
              text: `Title: ${result.title ?? "(untitled)"}\nURL: ${result.url}\nExtracted via: ${result.extractedVia}\nChars: ${result.charCount}\n\n${result.content}`,
            }],
          };
        } catch (e) {
          return {
            content: [{
              type: "text" as const,
              text: `web_fetch error: ${e instanceof Error ? e.message : String(e)}`,
            }],
          };
        }
      },
    ),

    tool(
      "web_search",
      "Search the web for current information. Returns search results or a conversational answer depending on provider. Use for real-time info, news, recent events.",
      {
        query: z.string().describe("Search query"),
        count: z.number().optional().describe("Number of results (1-10, default: 5)"),
        provider: z.enum(["brave", "perplexity", "grok"]).optional().describe("Search provider (auto-detected from available API keys)"),
        freshness: z.enum(["day", "week", "month", "year"]).optional().describe("How recent results should be"),
      },
      async ({ query, count, provider, freshness }) => {
        try {
          const result = await searchTool.execute({ query, count, provider, freshness });
          const parts: string[] = [`Provider: ${result.provider}`];
          if (result.answer) {
            parts.push(`\n${result.answer}`);
          }
          if (result.results.length > 0) {
            parts.push("");
            for (const r of result.results) {
              parts.push(`- ${r.title}\n  ${r.url}\n  ${r.snippet}${r.age ? ` (${r.age})` : ""}`);
            }
          }
          return {
            content: [{ type: "text" as const, text: parts.join("\n") }],
          };
        } catch (e) {
          return {
            content: [{
              type: "text" as const,
              text: `web_search error: ${e instanceof Error ? e.message : String(e)}`,
            }],
          };
        }
      },
    ),
  ];
}

function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]] || undefined;
  return value;
}

interface WebConfig {
  search: { provider?: string; braveApiKey?: string; perplexityApiKey?: string; grokApiKey?: string };
  fetch: { maxChars?: number; cacheTtlMinutes?: number; firecrawlApiKey?: string };
}

function loadWebConfig(homePath?: string): WebConfig {
  const defaults: WebConfig = {
    search: {
      braveApiKey: process.env.BRAVE_API_KEY,
      perplexityApiKey: process.env.PERPLEXITY_API_KEY,
      grokApiKey: process.env.XAI_API_KEY,
    },
    fetch: { maxChars: 50_000, cacheTtlMinutes: 15 },
  };

  if (!homePath) return defaults;

  try {
    const configPath = join(homePath, "system", "config.json");
    if (!existsSync(configPath)) return defaults;
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const web = cfg.tools?.web;
    if (!web) return defaults;

    return {
      search: {
        provider: web.search?.provider,
        braveApiKey: resolveEnvVar(web.search?.braveApiKey) ?? defaults.search.braveApiKey,
        perplexityApiKey: resolveEnvVar(web.search?.perplexityApiKey) ?? defaults.search.perplexityApiKey,
        grokApiKey: resolveEnvVar(web.search?.grokApiKey) ?? defaults.search.grokApiKey,
      },
      fetch: {
        maxChars: web.fetch?.maxChars ?? defaults.fetch.maxChars,
        cacheTtlMinutes: web.fetch?.cacheTtlMinutes ?? defaults.fetch.cacheTtlMinutes,
        firecrawlApiKey: resolveEnvVar(web.fetch?.firecrawlApiKey),
      },
    };
  } catch (err: unknown) {
    console.warn("[ipc] Could not load web config:", err instanceof Error ? err.message : String(err));
    return defaults;
  }
}
