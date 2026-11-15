import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const { chromium } = createRequire(join(root, "packages/mcp-browser/package.json"))("playwright") as typeof import("playwright");
const component = "packages/ui/src/chat/ProjectSkillActions.tsx";
let browser: Browser;
let script: string;
let css: string;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ProjectSkillActions, type NewSkillDraft } from "./${component}";

        function SkillActionsHarness() {
          const [draft, setDraft] = useState<NewSkillDraft | null>(null);
          return (
            <ProjectSkillActions filesPending={false} onCreate={async () => true}
              newSkillDraft={draft} onNewSkillDraftChange={setDraft} />
          );
        }

        createRoot(document.getElementById("root")).render(<SkillActionsHarness />);
      `,
      loader: "tsx",
      resolveDir: root,
    },
    bundle: true,
    jsx: "automatic",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  script = bundle.outputFiles[0]!.text;
  const tailwind = await compile('@import "tailwindcss";', { base: root, onDependency() {} });
  css = tailwind.build(new Scanner({ sources: [{ base: root, pattern: component, negated: false }] }).scan());
  browser = await chromium.launch();
});

afterAll(async () => { await browser?.close(); });

it("vertically centers the native file picker before and after file selection", async () => {
  const page = await browser.newPage({ viewport: { width: 500, height: 280 } });
  try {
    await page.setContent(`<!doctype html><style>${css}
      :root{--border:#c6c6c6;--accent:#2c7456;--muted-foreground:#555}
      body{padding:20px;background:#fafafa;color:#202020;font:14px Arial}
    </style><div id="root"></div>`);
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Add skill" }).click();
    await page.getByRole("button", { name: "Import SKILL.md" }).click();
    const input = page.getByLabel("SKILL.md file");
    const submit = page.getByRole("button", { name: "Import skill" });

    expect(await input.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await submit.isEnabled()).toBe(false);
    for (const selected of [false, true]) {
      if (selected) {
        await input.setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from("# Example") });
        expect(await submit.isEnabled()).toBe(true);
      }
      await page.mouse.click(3, 3);
      const clip = await input.evaluate(element => {
        const field = parseFloat(getComputedStyle(element).borderTopWidth) > 0 ? element : element.parentElement!;
        const { x, y, width, height } = field.getBoundingClientRect();
        return { x, y, width, height };
      });
      const pixels = await page.screenshot({ clip });
      // The native button and filename live in the browser's shadow tree.
      const offset = await page.evaluate(async (png) => {
        const image = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        const inkRows = [];
        for (let y = 3; y < image.height - 3; y++) {
          for (let x = 6; x < Math.min(190, image.width - 6); x++) {
            const i = (y * image.width + x) * 4;
            if (data[i]! < 100 && data[i + 1]! < 100 && data[i + 2]! < 100) {
              inkRows.push(y + 0.5);
              break;
            }
          }
        }
        if (!inkRows.length) throw new Error("File picker text was not rendered");
        return (inkRows[0]! + inkRows.at(-1)!) / 2 - image.height / 2;
      }, pixels.toString("base64"));
      expect(Math.abs(offset), selected ? "with selected file" : "without selected file").toBeLessThanOrEqual(2);
      const evidence = process.env.MATRIX_PROJECT_SKILL_LAYOUT_EVIDENCE_DIR;
      if (evidence) await page.screenshot({ path: join(evidence, selected ? "skill-import-centered-selected.png" : "skill-import-centered-empty.png") });
    }
  } finally {
    await page.close();
  }
});
