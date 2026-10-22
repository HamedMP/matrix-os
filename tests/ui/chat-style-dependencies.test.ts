import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";

it("ships every relative stylesheet imported by shared Chat presentation", async () => {
  const entry = resolve(__dirname, "../../packages/ui/src/chat-agents/chat-agents.css");
  const css = await readFile(entry, "utf8");
  const imports = [...css.matchAll(/@import\s+["'](\.[^"']+)["']/g)].map(match => match[1]!);
  for (const relative of imports) {
    const dependency = await readFile(resolve(dirname(entry), relative), "utf8");
    expect(dependency.trim(), `Empty shared Chat stylesheet: ${relative}`).not.toBe("");
  }
});
