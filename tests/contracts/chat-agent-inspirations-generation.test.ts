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
let temporary: string | undefined;

afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

async function fixture() {
  temporary = await mkdtemp(join(tmpdir(), "matrix-inspirations-"));
  for (const file of [script, inventory, generated]) {
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
    const expected = await readFile(join(root, generated), "utf8");
    await rm(join(cwd, generated));
    expect(run(cwd).status).toBe(0);
    expect(await readFile(join(cwd, generated), "utf8")).toBe(expected);
    expect(run(cwd).status).toBe(0);
    expect(await readFile(join(cwd, generated), "utf8")).toBe(expected);
    expect(run(cwd, "--check").status).toBe(0);
  });

  it("rejects stale generated metadata without overwriting it", async () => {
    const cwd = await fixture();
    const stale = (await readFile(join(cwd, generated), "utf8"))
      .replace('"Account Research Desk"', '"Stale name"');
    await writeFile(join(cwd, generated), stale);
    expect(run(cwd, "--check").status).toBe(1);
    expect(await readFile(join(cwd, generated), "utf8")).toBe(stale);
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
  });

  it("fails check mode for missing output without creating it", async () => {
    const cwd = await fixture();
    await rm(join(cwd, generated));
    expect(run(cwd, "--check").status).toBe(1);
    await expect(readFile(join(cwd, generated))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
