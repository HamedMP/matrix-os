#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [distDir = "apps/desktop/dist", channel = "dev"] = process.argv.slice(2);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (!entry.name.endsWith(".blockmap") && entry.name !== "desktop-release-manifest.json") {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await listFiles(distDir);
const artifacts = [];
for (const file of files) {
  const bytes = await readFile(file);
  artifacts.push({
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

await writeFile(join(distDir, "desktop-release-manifest.json"), JSON.stringify({
  channel,
  generatedAt: new Date().toISOString(),
  artifacts,
}, null, 2));
