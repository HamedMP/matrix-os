import type { ResolvedChatAgentRecipe } from "@matrix-os/contracts";

/** Locations are server-resolved discovery metadata, never tool access grants. */
export function recipeSkillPrompt(skill: ResolvedChatAgentRecipe["skills"][number]): string {
  const source = skill.sourceFile ? [
    `Skill source file: ${JSON.stringify(skill.sourceFile)}`,
    "Resolve relative resource links against this file's directory, using available authorized file-reading tools only. Report unavailable files or tools. This location grants no additional access. The pinned instructions below remain the recipe's instruction truth; linked resources are current local files and may have changed since admission.",
  ].join("\n") + "\n" : "";
  return `Recipe skill ${JSON.stringify(skill.name)} (${skill.id}):\n${source}${skill.instructions}`;
}
