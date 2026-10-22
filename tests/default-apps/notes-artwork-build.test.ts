import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";

it("embeds Notes' canonical artwork so signed production iframe URLs need no extra image request", async () => {
  const result = await build({ root: resolve("home/apps/notes"), logLevel: "silent", build: { write: false } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []);
  const javascript = outputs.filter(output => output.type === "chunk").map(output => output.code).join("\n");
  const icon = await readFile("home/apps/_shared/app-artwork/notes.png");
  expect(javascript).toContain(`data:image/png;base64,${icon.toString("base64")}`);
  expect(outputs.filter(output => output.type === "asset" && /notes.*\.png$/i.test(output.fileName))).toHaveLength(0);
}, 20_000);

it("keeps the writing pane scrollable when a short window cannot fit its controls", () => {
    const css = readFileSync("home/apps/notes/src/design-refresh.css", "utf8");
    const short = css.split("@media (max-height: 500px)")[1];
    expect(short).toBeDefined();
    expect(short).toMatch(/\.app-shell \.editor-pane\s*\{[^}]*overflow-y:\s*auto/);
    expect(short).toMatch(/\.editor-pane > \*\s*\{[^}]*flex-shrink:\s*0/);
    expect(short).toMatch(/\.rich-editor-wrap[^}]*min-height:\s*180px/);
    expect(short).toMatch(/\.app-shell \.rich-editor\s*\{[^}]*overflow:\s*visible/);
  });
