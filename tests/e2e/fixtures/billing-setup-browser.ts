import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import type { Browser, Page } from "playwright";

const root = resolve(__dirname, "../../..");
const fixture = join(root, "tests/e2e/fixtures/billing-setup.tsx");
const require = createRequire(join(root, "packages/mcp-browser/package.json"));
const { chromium } = require("playwright") as typeof import("playwright");

export async function billingBrowser(): Promise<{ browser: Browser; script: string; css: string }> {
  const result = await build({
    absWorkingDir: root, entryPoints: [fixture], bundle: true, write: false,
    format: "iife", platform: "browser", jsx: "automatic",
    alias: {
      "@": join(root, "shell/src"),
      "@matrix-os/brand": join(root, "packages/brand/src/index.ts"),
      "@matrix-os/brand/tokens": join(root, "packages/brand/src/tokens.ts"),
      "@matrix-os/observability/events": join(root, "packages/observability/src/events.ts"),
    },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{
      name: "billing-data-boundaries",
      setup(builder) {
        const modules: Record<string, string> = {
          "@clerk/nextjs": "useAuth, useUser",
          "next/navigation": "usePathname, useSearchParams, useRouter",
          "next/image": "Image as default",
          "next/link": "Link as default",
          "@matrix-os/ui": "useGettingStartedBlocker",
        };
        builder.onResolve({ filter: /^(@clerk\/nextjs|next\/(navigation|image|link)|@matrix-os\/ui)$/ },
          args => ({ path: args.path, namespace: "billing-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "billing-fixture" }, args => ({
          contents: `export { ${modules[args.path]} } from ${JSON.stringify(fixture)};`, resolveDir: root,
        }));
        builder.onLoad({ filter: /\/(BootSequence|UserButton|RuntimeManager|posthog-client)\.tsx?$/ }, args => {
          const names = args.path.endsWith("BootSequence.tsx") ? "Empty as BootSequence"
            : args.path.endsWith("UserButton.tsx") ? "UserButton"
            : args.path.endsWith("RuntimeManager.tsx") ? "Empty as AddComputerOnboarding"
            : "capturePostHogEvent, capturePostHogLog, Empty as setPostHogPersonPropertiesOnce";
          return { contents: `export { ${names} } from ${JSON.stringify(fixture)};`, loader: "tsx" };
        });
        builder.onLoad({ filter: /\/settings\/sections\/[^/]+Section\.tsx$/ }, args => {
          if (args.path.endsWith("/BillingSection.tsx")) return;
          const name = args.path.split("/").at(-1)!.replace(".tsx", "");
          return { contents: `export { Empty as ${name}, Empty as default } from ${JSON.stringify(fixture)};`, loader: "tsx" };
        });
      },
    }],
  });
  const tailwind = await compile('@import "./shell/src/app/globals.css";', { base: root, onDependency() {} });
  const css = tailwind.build(new Scanner({ sources: [
    { base: join(root, "shell/src"), pattern: "**/*.{ts,tsx}", negated: false },
    { base: join(root, "tests/e2e/fixtures"), pattern: "billing-setup.tsx", negated: false },
  ] }).scan());
  const fonts = await readFile(join(root, "shell/src/app/fonts.css"), "utf8");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
  return { browser, script: result.outputFiles[0]!.text, css: fonts + css };
}

export async function openBilling(
  fixture: Awaited<ReturnType<typeof billingBrowser>>,
  width: number,
  height: number,
  query = "plans=1",
): Promise<Page> {
  const page = await fixture.browser.newPage({ viewport: { width, height }, timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => console.error("Billing fixture:", error.message));
  await page.clock.setFixedTime(new Date("2026-10-20T12:00:00Z"));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://matrix.test") { await route.abort(); return; }
    if (url.pathname === "/") {
      const flat = url.searchParams.get("theme") === "flat";
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html${flat ? ' data-theme-style="flat"' : ""}><head><style>${fixture.css}</style></head><body class="matrix-shell-fonts"><div id="root"></div></body></html>` });
    } else if (url.pathname === "/billing/status") {
      await route.fulfill({ json: {
        access: { runtimeProxyAllowed: false, reason: "billing_required" },
        trialOffer: { eligible: true, durationDays: 3, eligiblePlanSlugs: ["matrix_starter", "matrix_builder", "matrix_max"],
          durationDaysByPlan: { matrix_starter: 14, matrix_builder: 3, matrix_max: 3 } },
      } });
    } else if (/^\/(wallpapers|agent-logos)\/[\w./-]+$/.test(url.pathname) && !url.pathname.includes("..")) {
      const path = join(root, "shell/public", url.pathname);
      await route.fulfill({ path });
    } else if (/^\/node_modules\/@fontsource-variable\/[\w/-]+\.woff2$/.test(url.pathname)) {
      await route.fulfill({ path: join(root, "shell", url.pathname), contentType: "font/woff2" });
    } else if (url.pathname === "/billing/checkout") {
      await route.fulfill({ status: 503, json: { error: "Checkout is unavailable. Try again in a moment." } });
    } else {
      await route.abort();
    }
  });
  await page.goto(`http://matrix.test/?${query}`);
  await page.addScriptTag({ content: fixture.script });
  await page.getByRole("heading", { name: "Choose your Matrix computer" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Starter", exact: false }).waitFor();
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  // Wait for the production Settings entrance before measuring/snapshotting.
  await page.waitForFunction(() => {
    const backdrop = document.querySelector('[aria-label="Close settings"]');
    return backdrop && getComputedStyle(backdrop).opacity === "1";
  });
  return page;
}
