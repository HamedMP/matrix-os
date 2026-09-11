import { CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES, type ChatAgentRecipeCatalog } from "@matrix-os/contracts";

export function recipeSkillInstructionBytes(selected: readonly string[], skills: ChatAgentRecipeCatalog["skills"]): number {
  // Request-local membership, bounded by the eight-skill recipe limit.
  const selectedIds = new Set(selected);
  return skills.reduce((bytes, skill) => bytes + (selectedIds.has(skill.id) ? skill.instructionBytes ?? 0 : 0), 0);
}

export function recipeSkillsFit(selected: readonly string[], skills: ChatAgentRecipeCatalog["skills"]): boolean {
  return recipeSkillInstructionBytes(selected, skills) <= CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES;
}
