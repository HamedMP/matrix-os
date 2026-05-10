import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { createBrowserTool, type BrowserAction } from "./browser-tool.js";

export interface BrowserServerConfig {
  homePath: string;
  headless?: boolean;
  timeout?: number;
  idleTimeout?: number;
  defaultProfile?: string;
}

export function createBrowserMcpServer(config: BrowserServerConfig) {
  async function getLauncher() {
    try {
      const pw = await import("playwright");
      return async (opts?: { headless?: boolean; userDataDir?: string }) => {
        const headless = opts?.headless ?? config.headless ?? true;
        if (opts?.userDataDir) {
          const context = await pw.chromium.launchPersistentContext(opts.userDataDir, {
            headless,
            serviceWorkers: "block",
          });
          return {
            newPage: () => context.newPage(),
            close: () => context.close(),
            contexts: () => [context],
          };
        }
        return pw.chromium.launch({ headless });
      };
    } catch (err: unknown) {
      console.warn("[mcp-browser] Playwright launcher unavailable:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  let browserTool: ReturnType<typeof createBrowserTool> | undefined;
  let browserToolInit: Promise<ReturnType<typeof createBrowserTool>> | undefined;

  async function ensureTool() {
    if (browserTool) return browserTool;
    if (browserToolInit) return browserToolInit;
    browserToolInit = createTool().catch((err: unknown) => {
      browserToolInit = undefined;
      throw err;
    });
    return browserToolInit;
  }

  async function createTool() {
    const launcher = await getLauncher();
    if (!launcher) {
      throw new Error("Browser is not available. Install Playwright to enable browser automation.");
    }
    browserTool = createBrowserTool({
      homePath: config.homePath,
      launcher: launcher as never,
      headless: config.headless,
      idleTimeoutMs: config.idleTimeout ?? 300_000,
      timeout: config.timeout ?? 30_000,
      defaultProfile: config.defaultProfile ?? "default",
    });
    return browserTool;
  }

  const ACTIONS: BrowserAction[] = [
    "launch", "close", "navigate", "screenshot", "snapshot",
    "click", "type", "select", "scroll", "evaluate",
    "wait", "tabs", "tab_new", "tab_close", "tab_switch",
    "pdf", "console", "status",
  ];

  return createSdkMcpServer({
    name: "matrix-os-browser",
    tools: [
      tool(
        "browser",
        "Web browser: navigate pages, take screenshots, fill forms, extract data via accessibility snapshots. Actions: launch, close, navigate, snapshot, click, type, select, scroll, evaluate, wait, screenshot, pdf, tabs, tab_new, tab_close, tab_switch, console, status.",
        {
          action: z.enum(ACTIONS as [BrowserAction, ...BrowserAction[]]).describe("Browser action to perform"),
          url: z.string().optional().describe("URL to navigate to"),
          selector: z.string().optional().describe("CSS selector for click/type/select/wait"),
          role: z.string().optional().describe("ARIA role for click (from snapshot)"),
          name: z.string().optional().describe("Accessible name for click (from snapshot)"),
          text: z.string().optional().describe("Text to type into input"),
          value: z.string().optional().describe("Value for select option or tab index"),
          expression: z.string().optional().describe("JavaScript expression for evaluate"),
          timeout: z.number().optional().describe("Wait timeout in ms (default: 30000)"),
          full_page: z.boolean().optional().describe("Full page screenshot (default: true)"),
          path: z.string().optional().describe("Relative save path under data/screenshots for screenshot/pdf"),
          profile: z.string().optional().describe("Persistent browser profile name (default: default)"),
        },
        async (input) => {
          try {
            const bt = await ensureTool();
            const result = await bt.execute({
              action: input.action,
              url: input.url,
              selector: input.selector,
              role: input.role,
              name: input.name,
              text: input.text,
              value: input.value,
              expression: input.expression,
              timeout: input.timeout,
              fullPage: input.full_page,
              path: input.path,
              profile: input.profile,
            });

            const parts: string[] = [];
            if (result.title) parts.push(`Title: ${result.title}`);
            if (result.url) parts.push(`URL: ${result.url}`);
            if (result.screenshotPath) parts.push(`Saved: ${result.screenshotPath}`);
            if (result.content) parts.push(result.content);
            if (result.error) parts.push(`Error: ${result.error}`);

            return {
              content: [{
                type: "text" as const,
                text: parts.length > 0 ? parts.join("\n") : `${result.action}: ${result.success ? "OK" : "FAILED"}`,
              }],
            };
          } catch (e) {
            console.warn("[mcp-browser] Browser tool failed:", e instanceof Error ? e.message : String(e));
            return {
              content: [{
                type: "text" as const,
                text: "Browser error: action failed",
              }],
            };
          }
        },
      ),
    ],
  });
}
