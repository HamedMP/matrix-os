import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { beforeAll, expect, it } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { nativeScheduledMessageFixture } from "../helpers/native-scheduled-message-fixture";

const root = resolve(import.meta.dirname, "../..");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const { chromium, _electron } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const output = process.env.MATRIX_NATIVE_CRON_UI_OUTPUT ?? join(root, "output/playwright/native-scheduled-message");
let script: string;
const styles: Record<string, string> = {};
beforeAll(async () => {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/native-scheduled-message.tsx"], bundle: true, write: false,
    outfile: "fixture.js", format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@renderer": join(root, "desktop/src/renderer/src"), "@": join(root, "shell/src") },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" }, plugins: [{ name: "offline-renderer", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: requireDesktop.resolve(args.path) }));
      builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, args => ({ path: requireDesktop.resolve(args.path) }));
      builder.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: "clerk", namespace: "offline" }));
      builder.onLoad({ filter: /.*/, namespace: "offline" }, () => ({ contents: "export const useAuth=()=>({userId:null,sessionId:null});export const useOrganization=()=>({organization:null});" }));
      builder.onLoad({ filter: /\/chat-provider-onboarding\.tsx$/ }, () => ({ contents: "export const ChatProviderOnboarding=({children})=>children;", loader: "tsx" }));
    } }] });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const candidates = new Scanner({ sources: ["desktop/src/renderer/src", "shell/src", "packages/ui/src"].map(path => ({
    base: join(root, path), pattern: "**/*.{ts,tsx}", negated: false,
  })) }).scan();
  // Compile the shipped host entrypoints independently: their Tailwind token
  // mappings differ. Bare Tailwind cannot render Web's bg-secondary bubble.
  for (const [surface, imports] of Object.entries({
    electron: '@import "./desktop/src/renderer/src/design/index.css";',
    web: '@import "./shell/src/app/fonts.css"; @import "./shell/src/app/globals.css";',
  })) {
    const tailwind = await compile(imports, { base: root, shouldRewriteUrls: true, onDependency() {} });
    const bundled = await build({ stdin: { contents: tailwind.build(candidates), loader: "css", resolveDir: root },
      bundle: true, write: false, loader: { ".ttf": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" },
      plugins: [{ name: "offline-shipped-assets", setup(builder) {
        builder.onResolve({ filter: /^\/fonts\// }, args => ({ path: join(root, "shell/public", decodeURIComponent(args.path)) }));
      } }],
    });
    // Local font bytes are embedded so neither host needs network/file grants.
    styles[surface] = bundled.outputFiles[0]!.text;
  }
}, 30_000);

function documentFor(surface: string) {
  return `<!doctype html><html data-surface="${surface}"><head><style>${styles[surface === "electron" ? "electron" : "web"]}
    #root{height:100vh;max-width:100%}
    </style></head><body class="${surface === "electron" ? "" : "matrix-shell-fonts"}"><div id="root"></div></body></html>`;
}
async function verify(page: Page, name: string) {
  await page.getByText("Scheduled result.", { exact: true }).waitFor({ timeout: 5000 });
  expect(await page.getByText("Sent by scheduled task", { exact: true }).count()).toBe(1);
  const time = page.locator("[data-scheduled-message] time");
  const timestamp = nativeScheduledMessageFixture().messages[0]!.createdAt;
  expect(await time.getAttribute("datetime")).toBe(timestamp);
  // The saved input is Aug 25 00:00Z; the Web contexts explicitly use en-US/Shanghai.
  if (name !== "electron") expect(await time.textContent()).toBe("Aug 25, 8:00 AM");
  else expect(await time.textContent()).toBeTruthy();
  const bounds = await page.locator("[data-scheduled-message]").boundingBox();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // A visible label alone does not prove the host theme/bubble CSS was loaded.
  const input = page.getByText("Scheduled task triggered.", { exact: true });
  const bubble = name === "electron" ? input.locator('xpath=ancestor::*[@data-slot="bubble-content"][1]') : input.locator("..");
  expect(await bubble.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, `${name}.png`) });
}

it.each(["web", "web-mobile"])("renders the shared native input row in %s with localized time and no network", async surface => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: surface === "web" ? { width: 1280, height: 720 } : { width: 390, height: 844 }, timezoneId: "Asia/Shanghai", locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.abort());
    await page.route("https://scheduled-ui.test/", route => route.fulfill({ contentType: "text/html", body: documentFor(surface) }));
    await page.goto("https://scheduled-ui.test/");
    await page.addScriptTag({ content: script });
    try {
      await verify(page, surface);
      const geometry = () => page.getByText("Scheduled result.", { exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect();
        const row = element.closest(".is-assistant")!;
        return { x: rect.x, width: rect.width, rowClass: row.className, textAlign: getComputedStyle(element).textAlign,
          justifyContent: getComputedStyle(row).justifyContent };
      });
      const native = await geometry();
      // Same actual ChatApp and host CSS with ordinary manual input: attribution
      // must not change the assistant's grouping or horizontal placement.
      await page.route("https://scheduled-ui.test/", route => route.fulfill({ contentType: "text/html",
        body: documentFor(surface).replace('data-surface=', 'data-variant="manual" data-surface=') }));
      await page.reload();
      await page.addScriptTag({ content: script });
      await page.getByText("Scheduled result.", { exact: true }).waitFor({ timeout: 5000 });
      expect(await page.locator("[data-scheduled-message]").count()).toBe(0);
      await page.evaluate(() => document.fonts.ready);
      const manual = await geometry();
      expect(native.x).toBeCloseTo(manual.x, 1);
      expect(native.rowClass).toBe(manual.rowClass);
      expect(errors).toEqual([]);
      await writeFile(join(output, `${surface}-alignment.json`), JSON.stringify({ native, manual }, null, 2));
    }
    catch (error) { throw new Error(`Offline ${surface} renderer: ${JSON.stringify(errors)}; text=${await page.locator("body").innerText()}`, { cause: error }); }
  } finally { await browser.close(); }
});

it.skipIf(process.env.MATRIX_NATIVE_CRON_UI_ELECTRON !== "1")("renders the actual Electron transcript in an isolated offline window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-cron-ui-"));
  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(dir, "index.html"), documentFor("electron").replace("</html>", '<script src="fixture.js"></script></html>'));
    await writeFile(join(dir, "fixture.js"), script);
    await writeFile(join(dir, "main.cjs"), `const {app,BrowserWindow,session}=require('electron');
      app.setPath('userData',${JSON.stringify(join(dir, "profile"))});
      app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
      const win=new BrowserWindow({width:1280,height:720,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(join(dir, "index.html"))});});`);
    app = await _electron.launch({ executablePath: requireDesktop("electron") as string, args: [join(dir, "main.cjs")] });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 720 });
    await verify(page, "electron");
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
}, 30_000);
