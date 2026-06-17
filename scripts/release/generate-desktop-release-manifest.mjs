import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const [directory, tag, version, channel, commit] = process.argv.slice(2);

if (!directory || !tag || !version || !channel || !commit) {
  console.error(
    "usage: node scripts/release/generate-desktop-release-manifest.mjs <directory> <tag> <version> <channel> <commit>",
  );
  process.exit(1);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (
      !entry.name.endsWith(".blockmap") &&
      entry.name !== "desktop-release-manifest.json" &&
      entry.name !== "SHA256SUMS.txt"
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

const files = await Promise.all(
  (await walk(directory)).map(async (path) => {
    const info = await stat(path);
    return {
      name: relative(directory, path).replaceAll("\\", "/"),
      size: info.size,
      sha256: await sha256(path),
    };
  }),
);

const manifest = {
  kind: "matrix-desktop-release",
  tag,
  version,
  channel,
  commit,
  generatedAt: new Date().toISOString(),
  artifacts: files,
};

await writeFile(
  join(directory, "desktop-release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  join(directory, "SHA256SUMS.txt"),
  `${files.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`,
);

console.log(`wrote manifest for ${files.length} desktop artifacts`);
