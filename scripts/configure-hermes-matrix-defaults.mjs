#!/usr/bin/env node

import { open, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

const DEFAULTS_VERSION = 1;
const MAX_CONFIG_BYTES = 1_048_576;
const MATRIX_DISABLED_SKILLS = ["google-workspace", "himalaya"];

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function normalizedDisabledSkills(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  // Hermes 0.20.x could serialize list-valued `config set` input as one
  // comma-separated scalar. Normalize that legacy shape during this one-time
  // migration rather than preserving a configuration that Hermes ignores.
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  throw new Error("Hermes skills.disabled must be a list of skill names");
}

async function atomicWrite(path, content) {
  const temporaryPath = `${path}.matrix-defaults-${process.pid}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        console.error("configure-hermes-matrix-defaults: temporary file close failed", closeError);
      }
    }
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== "ENOENT") {
        console.error("configure-hermes-matrix-defaults: temporary file cleanup failed", cleanupError);
      }
    }
    throw error;
  }
}

async function main() {
  const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");
  const configPath = join(hermesHome, "config.yaml");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

  let source = "{}\n";
  try {
    const metadata = await lstat(configPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Hermes config must be a regular file");
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error("Hermes config exceeds the supported size");
    }
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error("Hermes config is not valid YAML");
  }
  const current = document.toJS() ?? {};
  if (typeof current !== "object" || Array.isArray(current)) {
    throw new Error("Hermes config must be a mapping");
  }
  const currentVersion = current.skills?.config?.matrix?.defaults_version;
  if (Number.isInteger(currentVersion) && currentVersion >= DEFAULTS_VERSION) return;

  const disabled = normalizedDisabledSkills(current.skills?.disabled);
  document.setIn(
    ["skills", "disabled"],
    Array.from(new Set([...disabled, ...MATRIX_DISABLED_SKILLS])).sort(),
  );
  document.setIn(["skills", "config", "matrix", "defaults_version"], DEFAULTS_VERSION);

  await atomicWrite(configPath, String(document));
}

main().catch((error) => {
  console.error(
    "configure-hermes-matrix-defaults: failed",
    error instanceof Error ? error.message : "UnknownError",
  );
  process.exitCode = 1;
});
