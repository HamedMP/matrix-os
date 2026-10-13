import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = "scripts/generate-chat-agent-inspirations.mjs";
const inventory = "specs/121-chat-agent-templates/xai-marketplace-inventory.json";
const generated = "packages/ui/src/chat-agents/agent-inspirations.generated.ts";
const mobileGenerated = "apps/mobile/components/agents/agent-inspirations.generated.ts";
const outputs = [generated, mobileGenerated];
let temporary: string | undefined;

afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

async function fixture() {
  temporary = await mkdtemp(join(tmpdir(), "matrix-inspirations-"));
  for (const file of [script, inventory, ...outputs]) {
    await mkdir(dirname(join(temporary, file)), { recursive: true });
    await copyFile(join(root, file), join(temporary, file));
  }
  return temporary;
}

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(cwd, script), ...args], {
    cwd, encoding: "utf8", timeout: 10_000,
  });
}

describe("agent inspiration generation", () => {
  it("regenerates every byte deterministically from the checked-in inventory", async () => {
    const cwd = await fixture();
    const expected = await Promise.all(outputs.map((file) => readFile(join(root, file), "utf8")));
    const regenerated = () => Promise.all(outputs.map((file) => readFile(join(cwd, file), "utf8")));
    for (const file of outputs) await rm(join(cwd, file));
    expect(run(cwd).status).toBe(0);
    expect(await regenerated()).toEqual(expected);
    expect(run(cwd).status).toBe(0);
    expect(await regenerated()).toEqual(expected);
    expect(run(cwd, "--check").status).toBe(0);
  });

  it.each(outputs)("rejects stale generated metadata in %s without overwriting it", async (file) => {
    const cwd = await fixture();
    const stale = (await readFile(join(cwd, file), "utf8"))
      .replace('"Account Research Desk"', '"Stale name"');
    await writeFile(join(cwd, file), stale);
    expect(run(cwd, "--check").status).toBe(1);
    expect(await readFile(join(cwd, file), "utf8")).toBe(stale);
  });

  it("detects inventory edits outside the identifiers", async () => {
    const cwd = await fixture();
    const source = JSON.parse(await readFile(join(cwd, inventory), "utf8"));
    source.bots[0].description = "A revised description.";
    source.bots[0].skills.names.push("A new capability");
    await writeFile(join(cwd, inventory), JSON.stringify(source));
    expect(run(cwd, "--check").status).toBe(1);
    expect(run(cwd).status).toBe(0);
    expect(run(cwd, "--check").status).toBe(0);
    for (const file of outputs) {
      const contents = await readFile(join(cwd, file), "utf8");
      expect(contents).toContain("A revised description.");
      expect(contents).toContain("A new capability");
    }
  });

  it.each(outputs)("fails check mode for a missing %s without creating it", async (file) => {
    const cwd = await fixture();
    await rm(join(cwd, file));
    expect(run(cwd, "--check").status).toBe(1);
    await expect(readFile(join(cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives Native Mobile only the fields its gallery reads, one inspiration per line", async () => {
    const cwd = await fixture();
    const source = JSON.parse(await readFile(join(cwd, inventory), "utf8"));
    const lines = (await readFile(join(cwd, mobileGenerated), "utf8")).split("\n");
    const entries = lines.filter((line) => line.startsWith("  {\"id\":"))
      .map((line) => JSON.parse(line.replace(/,$/, "")));

    expect(entries).toEqual(source.bots.map((bot: {
      id: string; name: string; categories: string[]; description: string;
      skills: { names: string[] }; integrations: { names: string[] };
    }) => ({
      id: bot.id,
      name: bot.name,
      categories: bot.categories.filter((category) => category !== "From Grok Bot Team"),
      description: bot.description,
      skills: bot.skills.names,
      integrations: bot.integrations.names,
    })));
    expect(entries).toHaveLength(71);
  });
});
