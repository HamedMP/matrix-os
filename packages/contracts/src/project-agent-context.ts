import { z } from "zod/v4";
import { canonicalSafeLabel } from "#canonical-chat-primitives";

export const ProjectInstructionPathSchema = z.enum([
  "AGENTS.override.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md",
]);
export const ProjectSkillSourceSchema = z.enum([
  ".agents/skills", ".codex/skills", ".claude/skills", ".pi/skills", ".opencode/skills",
]);
export const ProjectMcpSourceSchema = z.enum([".mcp.json", ".codex/config.toml"]);
export const ProjectAgentConfigPathSchema = z.enum([...ProjectMcpSourceSchema.options, ".claude/settings.json"]);
const sources = [
  ...ProjectInstructionPathSchema.options,
  ...ProjectSkillSourceSchema.options,
  ...ProjectAgentConfigPathSchema.options,
] as const;
const ProjectAgentContextSourceSchema = z.enum(sources);
export const PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE = 64;
export const PROJECT_SKILL_FILE_MAX_BYTES = 64 * 1024;
export const ProjectAgentContextNameSchema = z.string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/)
  .pipe(canonicalSafeLabel(80, 80));

export const InstalledSkillManifestPathSchema = z.string().max(128).refine(file => {
  const parts = file.split("/");
  const [root, skills, entry, manifest] = parts;
  if (skills !== "skills" || !entry) return false;
  const name = root === "agents" && parts.length === 3 && entry.endsWith(".md")
    ? entry.slice(0, -3)
    : (root === ".agents" || root === ".claude") && parts.length === 4 && manifest === "SKILL.md" ? entry : null;
  return ProjectAgentContextNameSchema.safeParse(name).success;
});

export const ProjectAgentConfigFileSchema = z.string().max(128).refine(path => {
  if (ProjectInstructionPathSchema.safeParse(path).success || ProjectAgentConfigPathSchema.safeParse(path).success) return true;
  const parts = path.split("/");
  if (parts.length !== 4 || parts[3] !== "SKILL.md") return false;
  return ProjectSkillSourceSchema.safeParse(parts.slice(0, 2).join("/")).success
    && ProjectAgentContextNameSchema.safeParse(parts[2]).success;
});

export const ProjectAgentContextSchema = z.object({
  configFiles: z.array(ProjectAgentConfigPathSchema).max(ProjectAgentConfigPathSchema.options.length).optional(),
  instructions: z.array(ProjectInstructionPathSchema).max(ProjectInstructionPathSchema.options.length),
  skills: z.array(z.object({
    name: ProjectAgentContextNameSchema, source: ProjectSkillSourceSchema,
  }).strict()).max(ProjectSkillSourceSchema.options.length * PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE),
  mcpServers: z.array(z.object({
    name: ProjectAgentContextNameSchema, source: ProjectMcpSourceSchema,
  }).strict()).max(ProjectMcpSourceSchema.options.length * PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE),
  incompleteSources: z.array(ProjectAgentContextSourceSchema).max(sources.length),
}).strict();

export type ProjectInstructionPath = z.infer<typeof ProjectInstructionPathSchema>;
export type ProjectSkillSource = z.infer<typeof ProjectSkillSourceSchema>;
export type ProjectMcpSource = z.infer<typeof ProjectMcpSourceSchema>;
export type ProjectAgentContextSource = z.infer<typeof ProjectAgentContextSourceSchema>;
export type ProjectAgentContext = z.infer<typeof ProjectAgentContextSchema>;
