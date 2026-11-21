import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE,
  ProjectAgentConfigPathSchema,
  ProjectAgentContextNameSchema,
  ProjectAgentContextSchema,
  ProjectInstructionPathSchema,
  ProjectSkillSourceSchema,
  type ProjectAgentContext,
  type ProjectAgentContextSource,
  type ProjectMcpSource,
  type ProjectSkillSource,
} from "@matrix-os/contracts";
import { parse as parseToml, TomlError } from "smol-toml";
import { GalleryFileError, isFsError, type PinnedDirectory } from "./app-gallery/pinned-directory.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SKILL_DIRECTORY_ENTRIES = 128;

async function within<T>(
  root: PinnedDirectory,
  parts: readonly string[],
  inspect: (directory: PinnedDirectory) => Promise<T>,
): Promise<T> {
  const [name, ...rest] = parts;
  if (name === undefined) return inspect(root);
  const child = await root.child(name);
  try { return await within(child, rest, inspect); }
  finally { await child.close(); }
}

async function regularFile(directory: PinnedDirectory, name: string): Promise<boolean> {
  try {
    const stat = await lstat(join(directory.path, name));
    // Refuse hard links as well as symbolic links. The source must belong to this checkout.
    if (!stat.isFile() || stat.nlink !== 1) throw new GalleryFileError("Invalid file");
    return true;
  } catch (error) {
    if (isFsError(error, "ENOENT")) return false;
    throw error;
  }
}

export function projectAgentConfigFileExists(root: PinnedDirectory, path: string): Promise<boolean> {
  const parts = path.split("/");
  const name = parts.pop()!;
  return within(root, parts, directory => regularFile(directory, name));
}

/** Commit a complete starter without following parent links or overwriting an existing file. */
export async function createProjectAgentConfigFile(root: PinnedDirectory, path: string, content: string): Promise<void> {
  async function create(directory: PinnedDirectory, parts: string[]): Promise<void> {
    const [name, ...rest] = parts;
    if (rest.length > 0) {
      const child = await directory.ensureChild(name!);
      try { await create(child, rest); }
      finally { await child.close(); }
      return;
    }
    const stagingName = `.matrix-config-${randomUUID()}.tmp`;
    const pending = join(directory.path, stagingName);
    const handle = await directory.openFile(stagingName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      try { await handle.writeFile(content); }
      finally { await handle.close(); }
      await link(pending, join(directory.path, name!));
    } finally {
      try { await unlink(pending); }
      catch (error: unknown) {
        console.warn("[project-agent-context] Could not remove config staging file:", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }
  await create(root, path.split("/"));
}

function incompleteSource(error: unknown): boolean {
  return error instanceof GalleryFileError
    || ["EACCES", "EPERM", "ELOOP", "ENOTDIR", "EISDIR", "EIO"].some(code => isFsError(error, code));
}

async function scanSkills(
  root: PinnedDirectory,
  source: ProjectSkillSource,
  result: ProjectAgentContext,
): Promise<boolean> {
  return within(root, source.split("/"), async directory => {
    const entries = await directory.entries();
    const names: string[] = [];
    let scanned = 0;
    let complete = true;
    for await (const entry of entries) {
      if (++scanned > MAX_SKILL_DIRECTORY_ENTRIES) { complete = false; break; }
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (!entry.isDirectory()) continue;
      const name = ProjectAgentContextNameSchema.safeParse(entry.name);
      if (!name.success) { complete = false; continue; }
      try {
        if (await within(directory, [entry.name], child => regularFile(child, "SKILL.md"))) names.push(name.data);
      } catch (error) {
        if (isFsError(error, "ENOENT")) continue;
        if (!incompleteSource(error)) throw error;
        complete = false;
      }
    }
    result.skills.push(...names.sort().slice(0, PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE).map(name => ({ name, source })));
    return complete && names.length <= PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function scanMcp(
  root: PinnedDirectory,
  source: ProjectMcpSource,
  result: ProjectAgentContext,
): Promise<boolean> {
  const parts = source.split("/");
  const filename = parts.pop()!;
  const contents = await within(root, parts, async directory => {
    if (!await regularFile(directory, filename)) return null;
    result.configFiles?.push(source);
    // Check file type and link count again on the descriptor that supplies the bytes.
    return directory.readFile(filename, MAX_CONFIG_BYTES, { singleLink: true });
  });
  if (contents === null) return true;

  let manifest: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    manifest = source === ".mcp.json" ? JSON.parse(text) : parseToml(text, {
      maxDepth: 32,
      unsafeKeyBehaviour: "throw",
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof TomlError) return false;
    throw error;
  }
  if (!isRecord(manifest)) return false;
  const key = source === ".mcp.json" ? "mcpServers" : "mcp_servers";
  if (!Object.hasOwn(manifest, key)) return true;
  const declarations = manifest[key];
  if (!isRecord(declarations)) return false;

  let complete = true;
  const names: string[] = [];
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!isRecord(declaration) || !ProjectAgentContextNameSchema.safeParse(name).success) {
      complete = false;
      continue;
    }
    names.push(name);
  }
  result.mcpServers.push(...names.sort().slice(0, PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE).map(name => ({ name, source })));
  return complete && names.length <= PROJECT_AGENT_CONTEXT_ITEMS_PER_SOURCE;
}

/** Read only known repository sources relative to a held checkout directory. */
export async function readProjectAgentContext(root: PinnedDirectory): Promise<ProjectAgentContext> {
  const configFiles: NonNullable<ProjectAgentContext["configFiles"]> = [];
  const result: ProjectAgentContext = { configFiles, instructions: [], skills: [], mcpServers: [], incompleteSources: [] };
  async function scan(source: ProjectAgentContextSource, inspect: () => Promise<boolean>) {
    try {
      if (await inspect()) return;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return;
      if (!incompleteSource(error)) throw error;
    }
    result.incompleteSources.push(source);
  }

  for (const source of ProjectInstructionPathSchema.options) {
    await scan(source, async () => {
      if (await projectAgentConfigFileExists(root, source)) result.instructions.push(source);
      return true;
    });
  }
  for (const source of ProjectSkillSourceSchema.options) await scan(source, () => scanSkills(root, source, result));
  for (const source of ProjectAgentConfigPathSchema.options) {
    await scan(source, async () => {
      if (source !== ".claude/settings.json") return scanMcp(root, source, result);
      if (await projectAgentConfigFileExists(root, source)) configFiles.push(source);
      return true;
    });
  }
  return ProjectAgentContextSchema.parse(result);
}
