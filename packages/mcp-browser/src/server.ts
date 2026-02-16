import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { createBrowserTool, type BrowserAction } from "./browser-tool.js";

export interface BrowserServerConfig {
  homePath: string;
  headless?: boolean;
  timeout?: number;
  idleTimeout?: number;
}

export function createBrowserMcpServer(config: BrowserServerConfig) {
  async function getLauncher() {
    try {
      const pw = await import("playwright");
      return (opts?: { headless?: boolean }) =>
        pw.chromium.launch({ headless: opts?.headless ?? config.headless ?? true });
    } catch {
      return null;
    }
  }

  let browserTool: ReturnType<typeof createBrowserTool> | undefined;

  async function ensureTool() {
    if (browserTool) return browserTool;
    const launcher = await getLauncher();
    if (!launcher) {
      throw new Error("Browser not available. Install Playwright: pnpm --filter mcp-browser exec playwright install chromium");
    }
    browserTool = createBrowserTool({
      homePath: config.homePath,
      launcher: launcher as never,
      headless: config.headless,
      idleTimeoutMs: config.idleTimeout ?? 300_000,
      timeout: config.timeout ?? 30_000,
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
          path: z.string().optional().describe("Custom save path for screenshot/pdf"),
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
            return {
              content: [{
                type: "text" as const,
                text: `Browser error: ${e instanceof Error ? e.message : String(e)}`,
              }],
            };
          }
        },
      ),
    ],
  });
}
