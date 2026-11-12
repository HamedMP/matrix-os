import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter, skillSources, type SkillSource } from "@matrix-os/kernel";
import {
  CHAT_AGENT_RECIPE_MAX_CATALOG_SKILLS,
  ChatAgentRecipeCatalogSchema,
  ChatAgentRecipeSkillIdSchema,
  InstalledSkillManifestPathSchema,
  PROJECT_SKILL_FILE_MAX_BYTES,
  ResolvedChatAgentRecipeSchema,
} from "@matrix-os/contracts";
import { GalleryFileError, isFsError, pinDirectory } from "../app-gallery/pinned-directory.js";
import { openedPathIsAuthorized } from "../file-preview-service.js";

const MAX_SKILL_FILE_BYTES = 28 * 1024;
const MAX_SCAN_ENTRIES = 2_048;
const bundledNames: Record<string, string> = {
  "matrix-integrations": "Matrix Integrations",
  "matrix-personal-daily-brief": "Personal Daily Brief",
};

class InvalidSkillError extends Error {}
type Source = SkillSource & { bundled: boolean };
type Skill = {
  id: string; name: string; description: string; instructions: string; sha256: string; sourceFile: string;
};

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function sourcesFor(options: { skillsRoot?: string; homePath?: string }): Promise<Source[]> {
  const home = options.homePath ? await realpath(options.homePath) : undefined;
  const candidates: Source[] = [
    ...(home ? skillSources(home).map((source) => ({ ...source, bundled: false })) : []),
    ...(options.skillsRoot ? [{
      label: "bundled", dir: await realpath(options.skillsRoot), kind: "directory-scan" as const, bundled: true,
    }] : []),
  ];
  const sources: Source[] = [];
  for (const source of candidates) {
    try {
      const info = await lstat(source.dir);
      // Do not let owner-controlled parent/root symlinks redefine a trusted root.
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(source.dir) !== resolve(source.dir)) continue;
      sources.push(source);
    } catch (error: unknown) {
      if (!missing(error)) throw error;
    }
  }
  return sources;
}

async function entriesFor(source: Source): Promise<string[]> {
  const entries: string[] = [];
  const directory = await opendir(source.dir);
  for await (const entry of directory) {
    if (entries.length >= MAX_SCAN_ENTRIES) throw new Error("Recipe skill discovery limit exceeded");
    entries.push(entry.name);
  }
  return entries.sort();
}

type CandidateReadOptions = { installedOnly: boolean } | { projectManifest: true };

function allowedManifestTarget(root: Source, filePath: string): boolean {
  const candidate = relative(root.dir, filePath);
  // Bundled installs use a link from an owner directory to a packaged skill directory.
  const installPath = root.bundled ? `.agents/skills/${candidate}` : `${root.label}/${candidate}`;
  return InstalledSkillManifestPathSchema.safeParse(installPath).success;
}

async function readCandidate(path: string, roots: readonly Source[], options: CandidateReadOptions): Promise<{ content: string; sourceFile: string }> {
  const parent = await realpath(dirname(path));
  const filePath = join(parent, basename(path));
  const manifest = "projectManifest" in options;
  const installedOnly = !manifest && options.installedOnly;
  const root = roots.find((candidate) => within(candidate.dir, filePath));
  if (!root || (manifest && !allowedManifestTarget(root, filePath))) throw new InvalidSkillError("Skill link leaves approved roots");

  const maxBytes = manifest ? PROJECT_SKILL_FILE_MAX_BYTES : MAX_SKILL_FILE_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: manifest });
  // Host bundles run on Linux, where we can pin the resolved parent for the entire read.
  if (manifest && process.platform === "linux") {
    const directory = await pinDirectory(parent);
    try {
      const bytes = await directory.readFile(basename(path), maxBytes, { singleLink: true });
      return { content: decoder.decode(bytes), sourceFile: filePath };
    } finally {
      await directory.close();
    }
  }
  // The final file must be regular, not a link, pipe or device. O_NONBLOCK prevents
  // a replaced FIFO from stalling the gateway between lstat and open.
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new InvalidSkillError("Invalid skill file");
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev
      || (!installedOnly && info.size > BigInt(maxBytes))) throw new InvalidSkillError("Invalid skill file");
    if (await realpath(parent) !== parent) throw new InvalidSkillError("Skill directory changed");
    if (manifest && (info.nlink !== 1n || !await openedPathIsAuthorized(filePath, info, root.dir))) {
      throw new InvalidSkillError("Invalid skill file");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    while (manifest && bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (!installedOnly && bytesRead > maxBytes) throw new InvalidSkillError("Skill is too large");
    return { content: decoder.decode(buffer.subarray(0, bytesRead), { stream: installedOnly }), sourceFile: filePath };
  } finally {
    await file.close();
  }
}

/** Read only a manifest under the owner's installed roots or the packaged skill root. */
export async function readInstalledSkillManifest(options: { skillsRoot?: string; homePath: string }, path: string): Promise<string | null> {
  const sources = await sourcesFor(options);
  const source = sources.find(candidate => !candidate.bundled && path.startsWith(`${candidate.label}/`));
  if (!source) return null;

  try {
    const { content } = await readCandidate(join(source.dir, path.slice(source.label.length + 1)), sources, { projectManifest: true });
    return content;
  } catch (error: unknown) {
    if (error instanceof InvalidSkillError || error instanceof GalleryFileError || missing(error)
      || isFsError(error, "ELOOP") || isFsError(error, "ERR_ENCODING_INVALID_ENCODED_DATA")) return null;
    throw error;
  }
}

function parseSkill(content: string, sourceFile: string, source: Source, installedOnly: boolean): Skill {
  const { frontmatter, body } = parseFrontmatter(content);
  if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string"
    || (source.bundled && frontmatter.author !== "Matrix OS")) throw new InvalidSkillError("Invalid skill metadata");
  const id = ChatAgentRecipeSkillIdSchema.safeParse(frontmatter.name).success
    ? frontmatter.name : `skill-${createHash("sha256").update(frontmatter.name).digest("hex")}`;
  const description = frontmatter.description.trim().slice(0, 400).replace(/[\uD800-\uDBFF]$/, "");
  const metadata = ChatAgentRecipeCatalogSchema.shape.skills.element.parse({
    id,
    name: Object.hasOwn(bundledNames, id) ? bundledNames[id] : frontmatter.name,
    description: ChatAgentRecipeCatalogSchema.shape.skills.element.shape.description.safeParse(description).success
      ? description : "Installed skill.",
  });
  const instructions = body.trim();
  const sha256 = createHash("sha256").update(instructions).digest("hex");
  // Validate location independently even during identity-only retry checks.
  ResolvedChatAgentRecipeSchema.shape.skills.element.shape.sourceFile.parse(sourceFile);
  if (!installedOnly) ResolvedChatAgentRecipeSchema.shape.skills.element.parse({ id, name: metadata.name, instructions, sha256, sourceFile });
  return { ...metadata, instructions, sha256, sourceFile };
}

/** Fresh, bounded, owner-scoped discovery. No process-global cache or client paths. */
export async function discoverRecipeSkills(options: { skillsRoot: string; homePath?: string }, installedOnly = false): Promise<Skill[]> {
  const sources = await sourcesFor(options);
  // Bounded by the public catalogue cap and discarded at the end of this request.
  const byId = new Map<string, Skill>();
  for (const source of sources) {
    for (const entry of await entriesFor(source)) {
      if (source.kind === "flat-scan" && !entry.endsWith(".md")) continue;
      const path = source.kind === "flat-scan" ? join(source.dir, entry) : join(source.dir, entry, "SKILL.md");
      let skill: Skill;
      try {
        const candidate = await readCandidate(path, sources, { installedOnly });
        skill = parseSkill(candidate.content, candidate.sourceFile, source, installedOnly);
      } catch (error: unknown) {
        if (!missing(error)) console.warn("[chat-agents] Skipped unavailable skill:", source.label, entry,
          error instanceof Error ? error.name : "UnknownError");
        continue;
      }
      if (byId.has(skill.id)) continue;
      if (byId.size >= CHAT_AGENT_RECIPE_MAX_CATALOG_SKILLS) throw new Error("Recipe skill catalogue limit exceeded");
      byId.set(skill.id, skill);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
