import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";

it("ships Resource Manager's canonical icon inside its JavaScript, without a separate image request", async () => {
  const result = await build({
    root: resolve("home/apps/resource-manager"),
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const javascript = outputs.flatMap(output => "output" in output ? output.output : [])
    .filter(output => output.type === "chunk")
    .map(output => output.code).join("\n");
  const icon = await readFile("home/system/icons/v3-resource-manager.png");
  expect(javascript).toContain(`data:image/png;base64,${icon.toString("base64")}`);
}, 20_000);
