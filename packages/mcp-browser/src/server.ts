import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { createBrowserService, type BrowserConfig } from "./browser.js";

export function createBrowserMcpServer(config: BrowserConfig) {
  let browserInstance: unknown = null;

  async function lazyBrowser() {
    if (browserInstance) return browserInstance;
    try {
      const pw = await import("playwright");
      browserInstance = await pw.chromium.launch({ headless: config.headless ?? true });
      return browserInstance;
    } catch {
      return null;
    }
  }

  async function getService() {
    const browser = await lazyBrowser();
    return createBrowserService(config, browser as never);
  }

  return createSdkMcpServer({
    name: "matrix-os-browser",
    tools: [
      tool(
        "browse_web",
        "Browse the web: navigate to a URL, take screenshots, extract text, or search. Screenshots are saved to ~/data/screenshots/.",
        {
          url: z.string().optional().describe("URL to navigate to (required for navigate, screenshot, extract)"),
          action: z.enum(["navigate", "screenshot", "extract", "search"]).describe("What to do"),
          selector: z.string().optional().describe("CSS selector to extract text from (for extract action)"),
          query: z.string().optional().describe("Search query (for search action)"),
          save_as: z.string().optional().describe("Custom filename for screenshot (without extension)"),
        },
        async ({ url, action, selector, query, save_as }) => {
          try {
            const svc = await getService();

            switch (action) {
              case "navigate": {
                if (!url) return textResult("navigate requires a url");
                const nav = await svc.navigate(url);
                return textResult(
                  `Title: ${nav.title}\nURL: ${nav.url}\nStatus: ${nav.status}\n\n${nav.text}`,
                );
              }
              case "screenshot": {
                if (!url) return textResult("screenshot requires a url");
                const shot = await svc.screenshot(url, { saveAs: save_as });
                return textResult(`Screenshot saved to ${shot.path}`);
              }
              case "extract": {
                if (!url) return textResult("extract requires a url");
                const ext = await svc.extract(url, selector);
                return textResult(ext.text);
              }
              case "search": {
                if (!query) return textResult("search requires a query");
                const srch = await svc.search(query);
                if (srch.results.length === 0) return textResult("No results found");
                const formatted = srch.results
                  .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
                  .join("\n\n");
                return textResult(formatted);
              }
            }
          } catch (e) {
            return textResult(`Browser error: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),
    ],
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
