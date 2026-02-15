import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./agents.js";

export interface AppMeta {
  name: string;
  description?: string;
  icon?: string;
  category: string;
  theme_accent?: string;
  theme_background?: string;
  data_dir?: string;
  author?: string;
  version?: string;
}

export function loadAppMeta(
  appsDir: string,
  appEntry: string,
): AppMeta {
  const baseName = appEntry.replace(/\.html$/, "");

  const candidatePaths = [
    join(appsDir, `${baseName}.matrix.md`),
    join(appsDir, baseName, "matrix.md"),
  ];

  for (const metaPath of candidatePaths) {
    if (existsSync(metaPath)) {
      try {
        const content = readFileSync(metaPath, "utf-8");
        const { frontmatter } = parseFrontmatter(content);

        const strOrUndef = (v: unknown) =>
          typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

        return {
          name: strOrUndef(frontmatter.name) ?? baseName,
          description: strOrUndef(frontmatter.description),
          icon: strOrUndef(frontmatter.icon),
          category: strOrUndef(frontmatter.category) ?? "utility",
          theme_accent: strOrUndef(frontmatter.theme_accent),
          theme_background: strOrUndef(frontmatter.theme_background),
          data_dir: strOrUndef(frontmatter.data_dir),
          author: strOrUndef(frontmatter.author),
          version: strOrUndef(frontmatter.version),
        };
      } catch {
        return { name: baseName, category: "utility" };
      }
    }
  }

  return { name: baseName, category: "utility" };
}
