#!/usr/bin/env node
// Validates release-notes/<version>.json against the shared Desktop schema.
// Usage: node scripts/release-notes/validate.mjs [release-notes-dir]
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseNotesSchema } from "../../desktop/src/shared/release-notes.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAX_FILE_BYTES = 64 * 1024;

function formatIssue(issue) {
  const path = issue.path
    .map((part, index) => (typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`))
    .join("");
  return `${path || "(root)"}: ${issue.message}`;
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** @returns {Promise<{ files: string[]; errors: string[] }>} */
export async function validateReleaseNotesDirectory(dir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const errors = [];
  for (const file of files) {
    const path = join(dir, file);
    if ((await stat(path)).size > MAX_FILE_BYTES) {
      errors.push(`${file}: larger than ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      errors.push(`${file}: not valid JSON`);
      continue;
    }
    const parsed = ReleaseNotesSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${file}: ${formatIssue(issue)}`);
      continue;
    }
    const notes = parsed.data;
    if (`${notes.version}.json` !== file) {
      errors.push(`${file}: version ${notes.version} does not match the file name`);
    }
    for (const [index, highlight] of notes.highlights.entries()) {
      if (highlight.media && !(await fileExists(join(dir, "media", highlight.media)))) {
        errors.push(`${file}: highlights[${index}].media ${highlight.media} is not in release-notes/media/`);
      }
    }
  }
  return { files, errors };
}

async function main() {
  const dir = resolve(process.argv[2] ?? join(repoRoot, "release-notes"));
  const { files, errors } = await validateReleaseNotesDirectory(dir);
  if (errors.length > 0) {
    for (const error of errors) console.error(`release-notes: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`release notes valid (${files.length} file${files.length === 1 ? "" : "s"})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("release-notes: validation failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
