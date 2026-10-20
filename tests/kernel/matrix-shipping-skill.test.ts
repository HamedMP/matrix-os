import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseFrontmatter } from "../../packages/kernel/src/agents.js";
import { createChatAgentRecipeResolver } from "../../packages/gateway/src/chat/agent-recipe.js";

it("discovers and resolves the canonical shipping skill through the real Chat recipe path", async () => {
  const skillsRoot = resolve(__dirname, "../../skills/matrix");
  const sourceFile = realpathSync(join(skillsRoot, "ship/SKILL.md"));
  const { body } = parseFrontmatter(readFileSync(sourceFile, "utf8"));
  const instructions = body.trim();
  const resolver = createChatAgentRecipeResolver({ skillsRoot, services: [] });
  expect((await resolver.catalog()).skills.find(skill => skill.id === "matrix-ship"))
    .toMatchObject({ id: "matrix-ship", instructionBytes: Buffer.byteLength(instructions) });
  const recipe = await resolver.resolve({ skills: ["matrix-ship"], integrations: [], output: "Qualify PR 2798 under ENG-349" });
  expect(recipe.skills).toEqual([expect.objectContaining({ id: "matrix-ship", instructions, sourceFile,
    sha256: createHash("sha256").update(instructions).digest("hex") })]);
  await expect(resolver.revalidate(recipe)).resolves.toBeUndefined();
});
