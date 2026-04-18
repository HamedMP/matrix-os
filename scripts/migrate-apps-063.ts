#!/usr/bin/env bun
/**
 * Spec 063 one-time manifest migration.
 *
 * Brings legacy ~/matrixos/apps/{slug}/matrix.json files up to the schema
 * required by packages/gateway/src/app-runtime/manifest-schema.ts:
 *   - adds `runtime: "static"` when absent (pre-063 implicit default)
 *   - adds `slug` (= directory name)
 *   - adds `runtimeVersion: "^1.0.0"`
 *   - adds `listingTrust: "first_party"` so distribution-policy resolves to
 *     `installable` instead of falling through to `blocked`
 *
 * The script is idempotent: existing fields are never overwritten. Each
 * migrated manifest is re-parsed with the real Zod schema and rolled back
 * on failure so nothing ends in a half-migrated state.
 *
 * Usage:
 *   bun scripts/migrate-apps-063.ts --dry-run   # show planned changes
 *   bun scripts/migrate-apps-063.ts             # apply
 */
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { AppManifestSchema } from "../packages/gateway/src/app-runtime/manifest-schema.js";

const APPS_DIR = join(homedir(), "matrixos", "apps");
const DRY_RUN = process.argv.includes("--dry-run");

type Manifest = Record<string, unknown>;

function migrate(current: Manifest, slug: string): { next: Manifest; added: string[] } {
  const next = { ...current };
  const added: string[] = [];
  if (next.runtime === undefined) { next.runtime = "static"; added.push("runtime"); }
  if (next.slug === undefined) { next.slug = slug; added.push("slug"); }
  if (next.runtimeVersion === undefined) { next.runtimeVersion = "^1.0.0"; added.push("runtimeVersion"); }
  if (next.listingTrust === undefined) { next.listingTrust = "first_party"; added.push("listingTrust"); }
  return { next, added };
}

async function main() {
  const entries = await readdir(APPS_DIR, { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const slug of slugs) {
    const manifestPath = join(APPS_DIR, slug, "matrix.json");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      console.log(`  skip  ${slug} (no matrix.json)`);
      skipped++;
      continue;
    }

    let current: Manifest;
    try {
      current = JSON.parse(raw);
    } catch (err) {
      console.log(`  FAIL  ${slug}: invalid JSON — ${err instanceof Error ? err.message : err}`);
      failed++;
      continue;
    }

    const { next, added } = migrate(current, slug);
    if (added.length === 0) {
      console.log(`  ok    ${slug} (already new-schema)`);
      skipped++;
      continue;
    }

    const parsed = AppManifestSchema.safeParse(next);
    if (!parsed.success) {
      console.log(`  FAIL  ${slug}: schema rejects migrated manifest`);
      console.log(`        ${parsed.error.message.split("\n")[0]}`);
      failed++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  plan  ${slug} + [${added.join(", ")}]`);
      migrated++;
      continue;
    }

    const backupPath = `${manifestPath}.bak`;
    await writeFile(backupPath, raw, "utf8");
    await writeFile(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`  done  ${slug} + [${added.join(", ")}]`);
    migrated++;
  }

  console.log();
  console.log(`migrated: ${migrated}, skipped: ${skipped}, failed: ${failed}`);
  if (DRY_RUN) console.log("(dry run — no files changed)");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
