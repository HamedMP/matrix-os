import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_TEMPLATES = 200;

const FrontmatterSchema = z.object({
  name: z.string().regex(TEMPLATE_NAME).optional(),
  description: z.string().max(500).optional(),
  command: z.string().min(1).max(4096),
}).passthrough();

export interface TerminalTemplate {
  name: string;
  description: string;
  /** The shell command line from the template's frontmatter, run as `sh -lc`. */
  command: string;
  /** Instructions sent ahead of the task as the first message. */
  body: string;
  source: "matrix" | "herdr";
}

/**
 * Agent role templates: Markdown files with `name`, `description` and `command`
 * frontmatter and instructions as the body. Matrix's own folder,
 * `~/agents/templates/`, wins over Herdr's (`~/.config/herdr-core/templates/`),
 * which is read so templates written for Herdr work unchanged.
 */
export function createTerminalTemplates(options: { homePath: string }) {
  const folders: Array<{ dir: string; source: TerminalTemplate["source"] }> = [
    { dir: join(options.homePath, "agents", "templates"), source: "matrix" },
    { dir: join(options.homePath, ".config", "herdr-core", "templates"), source: "herdr" },
  ];

  async function readTemplate(path: string, fileName: string, source: TerminalTemplate["source"]): Promise<TerminalTemplate | undefined> {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size > MAX_TEMPLATE_BYTES) return undefined;
    const text = await readFile(path, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!match) return undefined;
    let frontmatter: unknown;
    try { frontmatter = parseYaml(match[1]!); }
    catch (error: unknown) {
      if (error instanceof Error) return undefined;
      throw error;
    }
    const parsed = FrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) return undefined;
    const name = parsed.data.name ?? fileName.replace(/\.md$/, "");
    if (!TEMPLATE_NAME.test(name)) return undefined;
    return {
      name,
      description: parsed.data.description ?? "",
      command: parsed.data.command,
      body: match[2]!.trim(),
      source,
    };
  }

  async function list(): Promise<TerminalTemplate[]> {
    const byName = new Map<string, TerminalTemplate>();
    for (const folder of folders) {
      let entries: string[];
      try {
        entries = await readdir(folder.dir);
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) continue;
        throw error;
      }
      for (const fileName of entries.filter((entry) => entry.endsWith(".md")).sort()) {
        if (byName.size >= MAX_TEMPLATES) break;
        let template: TerminalTemplate | undefined;
        try {
          template = await readTemplate(join(folder.dir, fileName), fileName, folder.source);
        } catch (error: unknown) {
          console.warn("[gateway] terminal template unreadable", error instanceof Error ? error.name : "unknown_error");
          continue;
        }
        if (template && !byName.has(template.name)) byName.set(template.name, template);
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  return {
    list,
    async get(name: string): Promise<TerminalTemplate | undefined> {
      if (!TEMPLATE_NAME.test(name)) return undefined;
      return (await list()).find((template) => template.name === name);
    },
  };
}

export type TerminalTemplates = ReturnType<typeof createTerminalTemplates>;
