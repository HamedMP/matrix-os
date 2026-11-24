import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";
import type { ProjectSetupDraft } from "@matrix-os/contracts";

const root = resolve(import.meta.dirname, "../..");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
let browser: Browser;
let script: string;
let css: string;

beforeAll(async () => {
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/e2e/fixtures/project-setup-layout.tsx"], bundle: true, write: false,
    outfile: "fixture.js", format: "iife", platform: "browser", jsx: "automatic",
    alias: {
      "@matrix-os/brand/marks": join(root, "packages/brand/src/marks.ts"),
      "@matrix-os/brand/tokens": join(root, "packages/brand/src/tokens.ts"),
      "@matrix-os/brand": join(root, "packages/brand/src/index.ts"),
      "@": join(root, "shell/src"),
    },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{ name: "standalone-shell", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
      builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
      builder.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: "clerk", namespace: "standalone-shell" }));
      builder.onLoad({ filter: /.*/, namespace: "standalone-shell" }, () => ({
        contents: "export const useAuth=()=>({userId:null,sessionId:null});export const useOrganization=()=>({organization:null});",
      }));
    } }],
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tailwind = await compile('@import "./shell/src/app/globals.css";', { base: root, onDependency() {} });
  css = tailwind.build(new Scanner({ sources: ["shell/src", "packages/ui/src"].map(path => ({
    base: join(root, path), pattern: "**/*.{ts,tsx}", negated: false,
  })) }).scan());
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
}, 30_000);

afterAll(async () => { await browser?.close(); });

it("keeps a visible, aligned Cancel setup button while a floating Web Chat grows and reaches Review", async () => {
  const evidenceDir = process.env.MATRIX_PROJECT_SETUP_WEB_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 760 } });
  const pending: ProjectSetupDraft = {
    chatId: "chat_setup", projectId: "proj_harbor", revision: 1, step: "guidance",
    currentQuestionMessageId: "msg_setup_question", interview: { focus: "intent", suggestions: [] },
    generation: { status: "running", runId: "run_setup" }, answers: { purpose: "" }, proposals: [],
    mcp: { state: "not_requested" }, updatedAt: "2026-11-24T12:00:00Z",
  };
  const review: ProjectSetupDraft = {
    ...pending, revision: 2, step: "review", currentQuestionMessageId: "msg_setup_review",
    interview: { focus: "review", suggestions: [] }, generation: { status: "completed" },
    proposals: [{ path: "AGENTS.md", content: "# Harbor\n\n" + "Confirm volunteer availability first.\n\n".repeat(24), status: "pending" }],
  };
  let reviewReady = false;
  await page.route("**/*", route => {
    switch (new URL(route.request().url()).pathname) {
      case "/":
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${css}</style><div id="root"></div>` });
      case "/api/workspace/projects":
        return route.fulfill({ json: { projects: [{ id: "proj_harbor", slug: "harbor", name: "Harbor Volunteer Scheduling" }] } });
      case "/api/chats/chat_setup/project-setup":
        return route.fulfill({ json: { draft: reviewReady ? review : pending } });
      default:
        return route.fulfill({ status: 404, json: {} });
    }
  });
  try {
    await page.goto("https://project-setup.test/");
    await page.addScriptTag({ content: script });
    const cancel = page.getByRole("button", { name: "Cancel setup", exact: true });
    await cancel.waitFor();
    const initialBox = (await cancel.boundingBox())!;
    expect(await cancel.evaluate(button => getComputedStyle(button).borderTopStyle)).toBe("solid");
    const question = page.getByText("Who should see the harbor schedule?", { exact: true });
    const label = page.locator("header[aria-label=\"Project setup\"]").getByText("Harbor Volunteer Scheduling", { exact: true });
    const composer = page.locator("[data-slot=chat-composer] .prompt-card");
    const questionBox = (await question.boundingBox())!;
    const labelBox = (await label.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    if (evidenceDir) await page.locator("[data-test-window]").screenshot({ path: join(evidenceDir, "web-setup-opening.png") });
    // The Web scroller reserves symmetric space for a visible scrollbar.
    const gutter = await question.evaluate(element => {
      const viewport = element.closest('[role="log"]')!.firstElementChild as HTMLElement;
      return (viewport.offsetWidth - viewport.clientWidth) / 2;
    });
    expect(questionBox.x - gutter).toBeCloseTo(labelBox.x, 0);
    expect(questionBox.x - gutter).toBeCloseTo(composerBox.x, 0);
    expect(composerBox.height).toBeLessThan(110);

    await page.getByRole("button", { name: "Receive running Chat frame" }).click();
    await page.getByText("Discussed scheduling preference 12.").waitFor();
    await expect.poll(() => page.getByText("Discussed scheduling preference 12.").evaluate(element => {
      const viewport = element.closest('[role="log"]')?.getBoundingClientRect();
      const message = element.getBoundingClientRect();
      return Boolean(viewport && message.bottom <= viewport.bottom && message.top >= viewport.top);
    })).toBe(true);
    const runningBox = (await cancel.boundingBox())!;
    expect(runningBox.y).toBeCloseTo(initialBox.y, 0);
    expect(await cancel.isEnabled()).toBe(true);
    if (evidenceDir) await page.locator("[data-test-window]").screenshot({ path: join(evidenceDir, "web-setup-generating.png") });

    reviewReady = true;
    await page.getByRole("button", { name: "Receive completed Chat frame" }).click();
    const save = page.getByRole("button", { name: "Save project setup", exact: true });
    await save.waitFor({ timeout: 8_000 });
    await save.scrollIntoViewIfNeeded();
    expect((await cancel.boundingBox())!.y).toBeCloseTo(initialBox.y, 0);
    if (evidenceDir) await page.locator("[data-test-window]").screenshot({ path: join(evidenceDir, "web-setup-review.png") });
    await cancel.click();
    await page.getByText("Returned to Harbor project", { exact: true }).waitFor();
  } finally {
    await page.close();
  }
}, 25_000);
