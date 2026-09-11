import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { discoverRecipeSkills } from "./agent-recipe-skills.js";
import {
  ChatAgentRecipeCatalogSchema,
  ChatAgentRecipeSchema,
  ResolvedChatAgentRecipeSchema,
  type ChatAgentRecipe,
  type ChatAgentRecipeCatalog,
  type ResolvedChatAgentRecipe,
} from "@matrix-os/contracts";

type PublicService = { id: string; name: string };

export interface ChatAgentRecipeResolver {
  catalog(): Promise<ChatAgentRecipeCatalog>;
  resolve(recipe: ChatAgentRecipe): Promise<ResolvedChatAgentRecipe>;
  revalidate(snapshot: ResolvedChatAgentRecipe): Promise<void>;
}

export class ChatAgentRecipeResolverError extends Error {
  constructor(readonly code: "recipe_unavailable") {
    super(code);
    this.name = "ChatAgentRecipeResolverError";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** The module-relative candidate resolves in both source and /opt/matrix/app host bundles. */
export async function discoverChatAgentRecipeSkillsRoot(options: {
  skillsRoot?: string;
  appRoot?: string;
  moduleUrl?: string;
} = {}): Promise<string> {
  const candidates = [
    options.skillsRoot,
    ...(options.appRoot ? [join(options.appRoot, "skills/matrix")] : []),
    fileURLToPath(new URL("../../../../skills/matrix/", options.moduleUrl ?? import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (await isDirectory(normalized)) return normalized;
  }
  throw new ChatAgentRecipeResolverError("recipe_unavailable");
}

export function createChatAgentRecipeResolver(options: {
  skillsRoot: string;
  homePath?: string;
  services: readonly PublicService[];
}): ChatAgentRecipeResolver {
  const services = ChatAgentRecipeCatalogSchema.shape.services.parse(
    [...options.services].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  );

  function validateServices(integrations: readonly { service: string }[]): void {
    if (integrations.some(({ service }) => !services.some((entry) => entry.id === service))) {
      throw new ChatAgentRecipeResolverError("recipe_unavailable");
    }
  }

  function unavailable(error: unknown): never {
    if (error instanceof ChatAgentRecipeResolverError) throw error;
    console.warn("[chat-agents] Recipe unavailable:", error instanceof Error ? error.name : "UnknownError");
    throw new ChatAgentRecipeResolverError("recipe_unavailable");
  }

  return {
    async catalog() {
      try {
        const skills = (await discoverRecipeSkills(options)).map(({ id, name, description, instructions }) => ({
          id, name, description, instructionBytes: Buffer.byteLength(instructions, "utf8"),
        }));
        return ChatAgentRecipeCatalogSchema.parse({ enabled: true, skills, services });
      } catch (error: unknown) {
        return unavailable(error);
      }
    },
    async resolve(recipeValue) {
      try {
        const recipe = ChatAgentRecipeSchema.parse(recipeValue);
        validateServices(recipe.integrations);
        const installed = recipe.skills.length ? await discoverRecipeSkills(options) : [];
        const skills = recipe.skills.map((id) => {
          const skill = installed.find((entry) => entry.id === id);
          if (!skill) throw new ChatAgentRecipeResolverError("recipe_unavailable");
          return { id, name: skill.name, instructions: skill.instructions, sha256: skill.sha256 };
        });
        return ResolvedChatAgentRecipeSchema.parse({ skills, integrations: recipe.integrations, output: recipe.output });
      } catch (error: unknown) {
        return unavailable(error);
      }
    },
    async revalidate(snapshotValue) {
      try {
        const snapshot = ResolvedChatAgentRecipeSchema.parse(snapshotValue);
        validateServices(snapshot.integrations);
        // Only installed identity is rechecked. Queues/retries retain the admitted
        // instructions even when a later edit is larger than today's admission limit.
        const installed = snapshot.skills.length ? await discoverRecipeSkills(options, true) : [];
        if (snapshot.skills.some((skill) => !installed.some((entry) => entry.id === skill.id))) {
          throw new ChatAgentRecipeResolverError("recipe_unavailable");
        }
      } catch (error: unknown) {
        return unavailable(error);
      }
    },
  };
}
