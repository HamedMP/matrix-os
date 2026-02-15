import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BrowserConfig {
  homePath: string;
  headless?: boolean;
  timeout?: number;
}

export interface NavigateResult {
  title: string;
  url: string;
  status: number;
  text: string;
}

export interface ScreenshotResult {
  path: string;
}

export interface ExtractResult {
  text: string;
}

export interface SearchResult {
  results: Array<{ title: string; url: string; snippet: string }>;
}

export interface BrowserService {
  navigate(url: string): Promise<NavigateResult>;
  screenshot(url: string, opts?: { saveAs?: string }): Promise<ScreenshotResult>;
  extract(url: string, selector?: string): Promise<ExtractResult>;
  search(query: string): Promise<SearchResult>;
  close(): Promise<void>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  textContent(selector: string): Promise<string | null>;
  $eval(selector: string, fn: (el: Element) => string): Promise<string>;
  // Playwright page.evaluate for running JS in browser context
  evaluate(fn: (() => unknown) | string): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
  close(): Promise<void>;
}

const MAX_TEXT_LENGTH = 2000;

export function createBrowserService(
  config: BrowserConfig,
  browser: BrowserLike | null,
): BrowserService {
  async function getPage(): Promise<PageLike> {
    if (!browser) {
      throw new Error("Browser not available. Install Playwright: pnpm --filter mcp-browser exec playwright install chromium");
    }
    const page = await browser.newPage();
    page.setDefaultTimeout(config.timeout ?? 30000);
    return page;
  }

  async function getPageText(page: PageLike): Promise<string> {
    const rawText = (await page.evaluate("document.body?.innerText ?? ''")) as string;
    return rawText.slice(0, MAX_TEXT_LENGTH);
  }

  return {
    async navigate(url: string): Promise<NavigateResult> {
      const page = await getPage();
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        const title = await page.title();
        const pageUrl = page.url();
        const status = response?.status() ?? 0;
        const text = await getPageText(page);
        return { title, url: pageUrl, status, text };
      } finally {
        await page.close();
      }
    },

    async screenshot(url: string, opts?: { saveAs?: string }): Promise<ScreenshotResult> {
      const page = await getPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const buffer = await page.screenshot({ fullPage: false });
        const filename = (opts?.saveAs ?? `screenshot-${Date.now()}`) + ".png";
        const screenshotPath = join(config.homePath, "data", "screenshots", filename);
        writeFileSync(screenshotPath, buffer);
        return { path: screenshotPath };
      } finally {
        await page.close();
      }
    },

    async extract(url: string, selector?: string): Promise<ExtractResult> {
      const page = await getPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        let text: string;
        if (selector) {
          text = await page.$eval(selector, (el: Element) => el.textContent ?? "");
        } else {
          text = await getPageText(page);
        }
        return { text };
      } finally {
        await page.close();
      }
    },

    async search(query: string): Promise<SearchResult> {
      const page = await getPage();
      try {
        const encoded = encodeURIComponent(query).replace(/%20/g, "+");
        await page.goto(`https://duckduckgo.com/?q=${encoded}`, { waitUntil: "domcontentloaded" });
        const results = (await page.evaluate(`
          Array.from(document.querySelectorAll('.result')).slice(0, 5).map(function(el) {
            return {
              title: (el.querySelector('.result__title') || {}).textContent || '',
              url: (el.querySelector('.result__url') || {}).textContent || '',
              snippet: (el.querySelector('.result__snippet') || {}).textContent || ''
            };
          })
        `)) as Array<{ title: string; url: string; snippet: string }>;
        return { results: results ?? [] };
      } finally {
        await page.close();
      }
    },

    async close(): Promise<void> {
      if (browser) {
        await browser.close();
      }
    },
  };
}
