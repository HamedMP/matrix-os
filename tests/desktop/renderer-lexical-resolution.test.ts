import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

it("renders the packaged Chat composer with its custom Lexical node", () => {
  // Exercise the real renderer resolver and Composer, not a test alias or a
  // dependency count: two physical Lexical copies reject ComposerTokenNode.
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { resolve } from "node:path";
    import { writeFileSync } from "node:fs";
    const { build, loadConfigFromFile } = await import("vite");
    const config = await loadConfigFromFile({ command: "build", mode: "production" }, resolve("desktop/electron.vite.config.ts"));
    const renderer = config.config.renderer;
    const entry = resolve("desktop/src/renderer/src/lexical-runtime-fixture.tsx");
    const result = await build({ ...renderer, configFile: false,
      root: resolve("desktop"), logLevel: "silent",
      plugins: [...renderer.plugins, {
        name: "packaged-composer-runtime-fixture",
        resolveId(id) { if (id === entry) return entry; },
        load(id) { if (id === entry) return \`
          import { createElement } from "react";
          import { renderToString } from "react-dom/server";
          import { ComposerPromptEditor } from "./features/chat/ComposerPromptEditor";
          export function renderComposer() {
            return renderToString(createElement(ComposerPromptEditor, {
              value: "", tokens: [], onChange() {}, onKeyDown() {},
              placeholder: "Write a test message", ariaLabel: "Acceptance composer",
            }));
          }
        \`; },
      }],
      build: { write: false, minify: false,
        lib: { entry, formats: ["es"] }, rollupOptions: { external: [] } },
    });
    try {
      const results = Array.isArray(result) ? result : [result];
      const chunk = results.flatMap(item => item.output ?? []).find(item => item.type === "chunk" && item.isEntry);
      if (!chunk) throw new Error("Composer entry missing");
      const fixture = await import("data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));
      writeFileSync(1, JSON.stringify({ markup: fixture.renderComposer() }));
    } catch (error) {
      writeFileSync(1, JSON.stringify({ error: error.message }));
    }
    // React's browser scheduler owns MessagePorts. This isolated build/render
    // child has no further work; do not leave those ports keeping it alive.
    process.exit(0);
  `], { cwd: root, env, encoding: "utf8", timeout: 30_000,
    maxBuffer: 1024 * 1024, stdio: "pipe" });
  const result = JSON.parse(output);
  expect(result.error).toBeUndefined();
  expect(result.markup).toContain('role="textbox"');
  expect(result.markup).toContain('aria-label="Acceptance composer"');
}, 35_000);
