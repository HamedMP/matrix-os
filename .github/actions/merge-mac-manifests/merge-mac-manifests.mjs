import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function extractFilesBlock(text) {
  const match = text.match(/^files:\n([\s\S]*?)(?=^[A-Za-z0-9_-]+:|(?![\s\S]))/m);
  if (!match) return [];
  const block = match[1];
  return block
    .split(/\n(?=  - url: )/)
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.trim().length > 0);
}

function withoutFilesBlock(text) {
  return text.replace(/^files:\n[\s\S]*?(?=^[A-Za-z0-9_-]+:|(?![\s\S]))/m, "");
}

const directory = process.env.INPUT_DIRECTORY;
const output = process.env.INPUT_OUTPUT || "latest-mac.yml";

if (!directory) {
  throw new Error("directory input is required");
}

const names = await readdir(directory);
const manifestNames = names.filter((name) => name.endsWith("-mac.yml") || name === "latest-mac.yml");
if (manifestNames.length < 2) {
  throw new Error(`expected at least 2 mac manifests in ${directory}, found ${manifestNames.length}`);
}

const manifests = await Promise.all(
  manifestNames.map(async (name) => ({
    name,
    text: await readFile(join(directory, name), "utf8"),
  })),
);

const files = [];
for (const manifest of manifests) {
  for (const entry of extractFilesBlock(manifest.text)) {
    const url = entry.match(/^\s*-\s+url:\s+(.+)$/m)?.[1]?.trim();
    if (url && !files.some((file) => file.includes(`url: ${url}`))) {
      files.push(entry);
    }
  }
}

if (files.length === 0) {
  throw new Error(`no files entries found in ${manifestNames.join(", ")}`);
}

const base = manifests[0].text;
const rest = withoutFilesBlock(base).trimStart().trimEnd();
const merged = `files:\n${files.join("\n")}\n${rest ? `${rest}\n` : ""}`;

await writeFile(join(directory, output), merged);
console.log(`wrote ${output} with ${files.length} files`);
