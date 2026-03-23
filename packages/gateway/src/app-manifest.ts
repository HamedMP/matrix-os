import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";

export const AppManifestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  runtime: z.enum(["static", "node", "python", "rust", "docker"]).default("static"),
  entry: z.string().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  framework: z.string().optional(),
  permissions: z.array(z.string()).default([]),
  resources: z
    .object({
      memory: z.string().optional(),
      cpu: z.number().optional(),
    })
    .optional(),
  category: z.string().default("utility"),
  icon: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  autoStart: z.boolean().default(false),
  storage: z
    .object({
      tables: z.record(
        z.string(),
        z.object({
          columns: z.record(z.string(), z.string()),
          indexes: z.array(z.string()).optional(),
        }),
      ).default({}),
    })
    .optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;

export function parseAppManifest(data: unknown): AppManifest {
  return AppManifestSchema.parse(data);
}

export function loadAppManifest(appDir: string): AppManifest | null {
  const jsonPath = join(appDir, "matrix.json");
  if (existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
      return parseAppManifest(raw);
    } catch {
      return null;
    }
  }

  const mdPath = join(appDir, "matrix.md");
  if (existsSync(mdPath)) {
    try {
      const content = readFileSync(mdPath, "utf-8");
      const fm = parseYamlFrontmatter(content);
      if (!fm) return null;
      return parseAppManifest({
        name: fm.name,
        description: fm.description,
        category: fm.category,
        icon: fm.icon,
        author: fm.author,
        version: fm.version != null ? String(fm.version) : undefined,
        runtime: "static",
      });
    } catch {
      return null;
    }
  }

  return null;
}

function parseYamlFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key && val) result[key] = val;
    }
  }
  return result;
}

const PORT_RANGE_START = 3100;
const PORT_RANGE_END = 3999;

export function assignPort(usedPorts: Set<number>): number {
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) return p;
  }
  throw new Error("No available ports in range 3100-3999");
}
