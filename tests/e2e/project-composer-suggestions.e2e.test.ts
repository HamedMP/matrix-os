import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const desktop = join(root, "desktop/src/renderer/src");
const desktopRequire = createRequire(join(root, "desktop/package.json"));
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
let browser: Browser;
let script: string;
let css: string;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { SharedChatComposer } from "@renderer/features/chat/SharedChatComposer";
        import { createCanonicalComposerSelection } from "@renderer/features/chat/canonical-composer-state";
        import { createCanonicalProviderCatalogFixture } from "./tests/contracts/fixtures/canonical-chat";
        const catalog = createCanonicalProviderCatalogFixture();
        catalog.instances[0].skills = [{id:"review",displayName:"Review",description:"Review changes",invocation:"/review"}];
        function Fixture() {
          const [value, setValue] = useState("");
          const [tokens, setTokens] = useState([]);
          const [sent, setSent] = useState("");
          const inProject = new URLSearchParams(location.search).has("project");
          const projectSlashScope = inProject ? {
            scope: "isolated-fixture", projectId: "fixture",
            read: async () => ({ skills: [{ name: "release-check", source: ".agents/skills" }, { name: "worktree-pr-monitor", source: ".agents/skills" }, { name: "check-very-long-project-skill-name-that-must-fit-in-a-narrow-chat-composer", source: ".agents/skills" }], instructions: [], mcpServers: [], incompleteSources: [] }),
          } : undefined;
          return <main className="flex h-[420px] w-full max-w-[640px] flex-col overflow-hidden">
            <header className="flex-1 overflow-y-auto">Project home {sent && <output>{sent}</output>}</header>
            <section className="relative flex min-h-0 shrink flex-col overflow-hidden">
              <SharedChatComposer value={value} onChange={setValue} referenceTokens={tokens}
                onReferenceTokensChange={setTokens} projectSlashScope={projectSlashScope}
                onSubmit={submission => { if (!inProject) throw new Error("Unexpected send"); setSent(submission.text); }}
                busy={false} catalog={catalog} selection={createCanonicalComposerSelection(catalog)}
                onSelectionChange={() => {}} instanceLocked={false} resources={[{kind:"file",id:"readme",label:"README.md"}]}
                ariaLabel="Start a chat" menuSide="bottom" />
            </section>
          </main>;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);
      `,
      loader: "tsx",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    outfile: join(root, "project-composer-suggestions.js"),
    platform: "browser",
    jsx: "automatic",
    alias: { "@renderer": desktop },
    loader: { ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "react-dedupe", setup(builder) {
      builder.onResolve({ filter: /^@matrix-os\/(ui|contracts)(?:\/.*)?$/ }, args => {
        const name = args.path.split("/")[1]!;
        return { path: createRequire(join(root, "packages", name, "package.json")).resolve(args.path) };
      });
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
    } }],
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tailwind.build(new Scanner({ sources: [
    { base: root, pattern: "tests/e2e/project-composer-suggestions.e2e.test.ts", negated: false },
    { base: desktop, pattern: "features/chat/**/*.{tsx,ts}", negated: false },
    { base: join(root, "packages/ui/src"), pattern: "chat/**/*.{tsx,ts}", negated: false },
  ] }).scan()) + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n")
    + await readFile(join(root, "packages/ui/src/chat/composer/chat-composer.css"), "utf8");
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
});

afterAll(async () => { await browser?.close(); });

it.each([
  { trigger: "/", list: "Skills and commands", label: "/review" },
  { trigger: "@", list: "Add", label: "README.md" },
])("keeps $trigger suggestions clickable above the clipped project composer", async ({ trigger, list, label }) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 460 } });
  page.setDefaultTimeout(4500);
  try {
    const origin = "https://matrix-fixture.invalid/";
    await page.route("**/*", route => route.request().url() === origin
      ? route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${css}
      :root{--bg-overlay:#fff;--border-default:#ccc;--text-primary:#222;--text-tertiary:#555}
      body{margin:20px;font:14px Arial}
    </style><div id="root"></div>` })
      : route.abort());
    await page.goto(origin);
    await page.addScriptTag({ content: script });
    const editor = page.getByRole("textbox", { name: "Start a chat" });
    await editor.pressSequentially(trigger);
    const popup = page.getByRole("listbox", { name: list, exact: true });
    const row = popup.getByRole("option", { name: label, exact: false });
    await row.waitFor();
    expect(await editor.evaluate(element => element === document.activeElement)).toBe(true);
    const hit = await row.evaluate(element => {
      const { left, top, width, height } = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(left + width / 2, top + height / 2));
    });
    expect(hit, "The suggestion must receive pointer events outside the composer container").toBe(true);
    expect(await popup.getAttribute("data-side")).toBe("top");
    const evidence = process.env.MATRIX_PROJECT_COMPOSER_EVIDENCE_DIR;
    if (evidence && trigger === "/") await page.screenshot({ path: join(evidence, "project-skill-slash-menu.png") });
    await row.click();
    await popup.waitFor({ state: "hidden" });
    await editor.getByText(label, { exact: true }).waitFor();
    if (trigger === "/") {
      await editor.press("ControlOrMeta+a");
      await editor.pressSequentially("/");
      await popup.waitFor({ state: "visible" });
      await page.locator("main").evaluate(element => { element.style.display = "none"; });
      await popup.waitFor({ state: "hidden" });
    }
  } finally {
    await page.close();
  }
});


it("selects the project Skill through the real composer without sending an installed Skill", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 460 } });
  page.setDefaultTimeout(4500);
  try {
    const origin = "https://matrix-fixture.invalid/?project";
    await page.route("**/*", route => route.request().url() === origin
      ? route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${css}
      :root{--bg-overlay:#fff;--border-default:#ccc;--text-primary:#222;--text-tertiary:#555}
      body{margin:20px;font:14px Arial}
      </style><div id="root"></div>` }) : route.abort());
    await page.goto(origin);
    await page.addScriptTag({ content: script });
    const editor = page.getByRole("textbox", { name: "Start a chat" });
    await editor.pressSequentially("/");
    const list = page.getByRole("listbox", { name: "Skills and commands" });
    await list.getByRole("option", { name: /release-check/ }).waitFor();
    expect(await list.getByRole("option", { name: /review/ }).count()).toBe(0);
    const evidence = process.env.MATRIX_PROJECT_COMPOSER_EVIDENCE_DIR;
    if (evidence) await page.screenshot({ path: join(evidence, "project-only-skill-slash-menu.png") });
    await list.getByRole("option", { name: /release-check/ }).click();
    await page.getByRole("button", { name: "Remove skill release-check" }).waitFor();
    expect(await page.locator("output").count()).toBe(0);
    await editor.press("Enter");
    await page.locator("output").waitFor();
    expect(await page.locator("output").textContent()).toContain(".agents/skills/release-check/SKILL.md");
  } finally {
    await page.close();
  }
});


// Fault: project-skill chips touched the card's top edge, had undersized
// removal targets, and let long names push the chip outside narrow composers.
it.each([
  { width: 800, theme: "dark" as const, touch: false },
  { width: 375, theme: "dark" as const, touch: false },
  { width: 800, theme: "light" as const, touch: false },
  { width: 375, theme: "light" as const, touch: true },
])("keeps project skills padded, bounded and removable at $width px ($theme, touch=$touch)", async ({ width, theme, touch }) => {
  const evidence = process.env.MATRIX_PROJECT_COMPOSER_EVIDENCE_DIR;
  const page = await browser.newPage({ viewport: { width, height: 460 }, colorScheme: theme, hasTouch: touch,
    ...(evidence ? { recordVideo: { dir: evidence, size: { width, height: 460 } } } : {}),
  });
  page.setDefaultTimeout(4500);
  try {
    const origin = "https://matrix-fixture.invalid/?project&chips";
    await page.route("**/*", route => route.request().url() === origin
      ? route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${css}
        :root{--bg-surface:#141414;--bg-overlay:#1c1c1c;--bg-hover:#262626;--bg-active:#262626;--border-default:#333;--border-subtle:#2a2a2a;--text-primary:#ededed;--text-secondary:#aaa;--text-tertiary:#777;--accent:#ededed;--text-on-accent:#141414;--radius-xl:12px}
        ${theme === "light" ? ":root{--bg-surface:#fff;--bg-overlay:#fff;--bg-hover:#f5f5f5;--bg-active:#e5e5e5;--border-default:#ddd;--border-subtle:#e5e5e5;--text-primary:#171717;--text-secondary:#666;--text-tertiary:#777;--accent:#171717;--text-on-accent:#fff}" : ""}
        body{margin:20px;background:${theme === "dark" ? "#0d0d0d" : "#fafafa"};color:var(--text-primary);font:14px system-ui}
      </style><div id="root"></div>` }) : route.abort());
    await page.goto(origin);
    await page.addScriptTag({ content: script });
    const editor = page.getByRole("textbox", { name: "Start a chat" });
    const select = async (name: string) => {
      await editor.fill("/" + name);
      await page.getByRole("listbox", { name: "Skills and commands" }).getByRole("option", { name: new RegExp(name) }).click();
    };
    await select("worktree-pr-monitor");
    await editor.fill("resolve it in a PR and");
    if (evidence) {
      await page.screenshot({ path: join(evidence, `project-skill-chips-${width}-${theme}.png`) });
      await page.locator(".prompt-card").screenshot({ path: join(evidence, `project-skill-chip-detail-${width}-${theme}.png`) });
    }
    const card = page.locator(".prompt-card");
    const list = page.getByRole("list", { name: "Selected project skills" });
    const bounds = await list.evaluate(element => {
      const card = element.closest(".prompt-card")!.getBoundingClientRect();
      const chip = element.querySelector("li")!.getBoundingClientRect();
      return { top: chip.top - card.top, left: chip.left - card.left, height: chip.height };
    });
    expect(bounds.top, "Keep breathing room above the skill chip").toBeGreaterThanOrEqual(12);
    expect(bounds.left, "Align chips with the message inset").toBeGreaterThanOrEqual(15);
    expect(bounds.height, "Keep the selected skill readable").toBeGreaterThanOrEqual(28);
    const remove = list.getByRole("button", { name: "Remove skill worktree-pr-monitor" });
    const target = await remove.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(touch ? 44 : 24);
    expect(target!.height).toBeGreaterThanOrEqual(touch ? 44 : 24);
    expect(await remove.locator("svg").count()).toBe(1);
    await remove.focus();
    expect(await remove.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await remove.press("Enter");
    expect(await list.count()).toBe(0);
    expect(await editor.textContent()).toBe("resolve it in a PR and");

    await select("worktree-pr-monitor");
    const longName = "check-very-long-project-skill-name-that-must-fit-in-a-narrow-chat-composer";
    await select(longName);
    for (const chip of await list.locator("li").all()) {
      const chipBox = await chip.boundingBox();
      const cardBox = await card.boundingBox();
      expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width - 12);
    }
    await page.getByRole("button", { name: "Remove skill " + longName }).click();
    expect(await list.locator("li").count()).toBe(1);
    await editor.fill("Keep this draft");
    await editor.press("Enter");
    await page.locator("output").waitFor();
    expect(await page.locator("output").textContent()).toContain(".agents/skills/worktree-pr-monitor/SKILL.md");
    expect(await page.locator("output").textContent()).not.toContain(longName);
  } finally {
    const video = page.video();
    await page.close();
    if (evidence && video) await video.saveAs(join(evidence, `project-skill-chip-interaction-${width}-${theme}.webm`));
  }
});
