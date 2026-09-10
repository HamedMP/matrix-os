import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@matrix-os/kernel";
import {
  ChatAgentRecipeCatalogSchema,
  ChatAgentRecipeSchema,
  ResolvedChatAgentRecipeSchema,
  type ChatAgentRecipe,
  type ChatAgentRecipeCatalog,
  type ResolvedChatAgentRecipe,
} from "@matrix-os/contracts";

const MAX_SKILL_FILE_BYTES = 28 * 1024;
const RECIPE_SKILL_DIRECTORIES = {
  "matrix-integrations": { directory: "integrations", name: "Matrix Integrations" },
  "matrix-personal-daily-brief": { directory: "personal-daily-brief", name: "Personal Daily Brief" },
} as const;

type RecipeSkillId = keyof typeof RECIPE_SKILL_DIRECTORIES;
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

async function readBoundedFile(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    throw new ChatAgentRecipeResolverError("recipe_unavailable");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) {
      throw new ChatAgentRecipeResolverError("recipe_unavailable");
    }
    const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SKILL_FILE_BYTES) throw new ChatAgentRecipeResolverError("recipe_unavailable");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch (error: unknown) {
      throw new ChatAgentRecipeResolverError("recipe_unavailable");
    }
  } finally {
    await file.close();
  }
}

export function createChatAgentRecipeResolver(options: {
  skillsRoot: string;
  services: readonly PublicService[];
}): ChatAgentRecipeResolver {
  const services = ChatAgentRecipeCatalogSchema.shape.services.parse(
    [...options.services].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  );
  const servicesById = new Map(services.map((service) => [service.id, service]));

  async function readSkill(id: RecipeSkillId) {
    try {
      const definition = RECIPE_SKILL_DIRECTORIES[id];
      const directory = join(options.skillsRoot, definition.directory);
      if (!await isDirectory(directory)) throw new ChatAgentRecipeResolverError("recipe_unavailable");
      const content = await readBoundedFile(join(directory, "SKILL.md"));
      const { frontmatter, body } = parseFrontmatter(content);
      if (frontmatter.name !== id || frontmatter.author !== "Matrix OS"
        || typeof frontmatter.description !== "string") {
        throw new ChatAgentRecipeResolverError("recipe_unavailable");
      }
      const instructions = body.trim();
      return {
        snapshot: ResolvedChatAgentRecipeSchema.shape.skills.element.parse({
          id,
          name: definition.name,
          instructions,
          sha256: createHash("sha256").update(instructions).digest("hex"),
        }),
        description: frontmatter.description,
      };
    } catch (error: unknown) {
      if (error instanceof ChatAgentRecipeResolverError) throw error;
      throw new ChatAgentRecipeResolverError("recipe_unavailable");
    }
  }

  async function assertSkillInstalled(id: RecipeSkillId): Promise<void> {
    let file;
    try {
      const directory = join(options.skillsRoot, RECIPE_SKILL_DIRECTORIES[id].directory);
      if (!await isDirectory(directory)) throw new ChatAgentRecipeResolverError("recipe_unavailable");
      file = await open(join(directory, "SKILL.md"), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await file.stat()).isFile()) throw new ChatAgentRecipeResolverError("recipe_unavailable");
    } catch (error: unknown) {
      if (error instanceof ChatAgentRecipeResolverError) throw error;
      throw new ChatAgentRecipeResolverError("recipe_unavailable");
    } finally {
      await file?.close();
    }
  }

  function validateServices(integrations: readonly { service: string }[]): void {
    if (integrations.some(({ service }) => !servicesById.has(service))) {
      throw new ChatAgentRecipeResolverError("recipe_unavailable");
    }
  }

  return {
    async catalog() {
      const skills = await Promise.all((Object.keys(RECIPE_SKILL_DIRECTORIES) as RecipeSkillId[])
        .sort().map(async (id) => {
          const resolved = await readSkill(id);
          return { id, name: resolved.snapshot.name, description: resolved.description };
        }));
      return ChatAgentRecipeCatalogSchema.parse({ enabled: true, skills, services });
    },
    async resolve(recipeValue) {
      try {
        const recipe = ChatAgentRecipeSchema.parse(recipeValue);
        validateServices(recipe.integrations);
        const skills = await Promise.all(recipe.skills.map((id) => {
          if (!(id in RECIPE_SKILL_DIRECTORIES)) throw new ChatAgentRecipeResolverError("recipe_unavailable");
          return readSkill(id as RecipeSkillId).then((skill) => skill.snapshot);
        }));
        return ResolvedChatAgentRecipeSchema.parse({ skills, integrations: recipe.integrations, output: recipe.output });
      } catch (error: unknown) {
        if (error instanceof ChatAgentRecipeResolverError) throw error;
        throw new ChatAgentRecipeResolverError("recipe_unavailable");
      }
    },
    async revalidate(snapshotValue) {
      try {
        const snapshot = ResolvedChatAgentRecipeSchema.parse(snapshotValue);
        validateServices(snapshot.integrations);
        await Promise.all(snapshot.skills.map((skill) => {
          if (!(skill.id in RECIPE_SKILL_DIRECTORIES)) throw new ChatAgentRecipeResolverError("recipe_unavailable");
          return assertSkillInstalled(skill.id as RecipeSkillId);
        }));
      } catch (error: unknown) {
        if (error instanceof ChatAgentRecipeResolverError) throw error;
        throw new ChatAgentRecipeResolverError("recipe_unavailable");
      }
    },
  };
}
