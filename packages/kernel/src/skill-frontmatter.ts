import { parseDocument } from "yaml";
import { parseFrontmatter } from "./agents.js";

/** Preserve legacy identities/bodies while sharing bounded skill extensions. */
export function parseSkillFrontmatter(content: string, { requireAuthorship = false } = {}) {
  const legacy = parseFrontmatter(content);
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const authors: unknown[] = [];
  if (!header || (!requireAuthorship && (Object.hasOwn(legacy.frontmatter, "triggers")
    || !/^metadata\s*:/m.test(header[1])))) return { ...legacy, authors };
  if (Buffer.byteLength(header[1]) > 28 * 1024) {
    if (requireAuthorship) throw new Error("Skill metadata exceeds its size limit");
    return { ...legacy, authors };
  }
  const document = parseDocument(header[1], { uniqueKeys: true, logLevel: "error" });
  // Owner metadata outside the new trigger extension stays ignored as before.
  // Inspect the AST without expanding aliases or changing legacy identities.
  if (!requireAuthorship && document.getIn(["metadata", "triggers"], true) === undefined) return { ...legacy, authors };
  if (document.errors.length) throw new Error("Invalid skill metadata");
  const declaration: unknown = document.toJS({ maxAliasCount: 0 });
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new Error("Invalid skill metadata");
  if ("author" in declaration && Object.hasOwn(declaration, "author")) authors.push(declaration.author);
  const extension = "metadata" in declaration ? declaration.metadata : undefined;
  const frontmatter = { ...legacy.frontmatter };
  if (extension && typeof extension === "object" && !Array.isArray(extension)) {
    if ("author" in extension && Object.hasOwn(extension, "author")) authors.push(extension.author);
    if (!Object.hasOwn(frontmatter, "triggers") && "triggers" in extension && Object.hasOwn(extension, "triggers")) {
      frontmatter.triggers = typeof extension.triggers === "string"
        ? extension.triggers.split(",").map(value => value.trim()).filter(Boolean) : extension.triggers;
    }
  }
  return { frontmatter, body: legacy.body, authors };
}
