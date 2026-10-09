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
