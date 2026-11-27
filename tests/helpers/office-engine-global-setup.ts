// Vitest global setup: tests under tests/default-apps/** import the office apps,
// which import home/apps/_shared/office-engine. That copy of packages/office/src
// is generated and git-ignored, so regenerate it before any test file loads.
// Up-to-date files are left untouched, so this costs a directory comparison.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_DIR, syncOfficeEngine } from "../../scripts/sync-office-engine.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default function setup(): void {
  // A partial checkout without the engine source cannot need the mirror; suites
  // that import it fail on their own import instead of every suite failing here.
  if (!existsSync(join(root, SOURCE_DIR))) {
    console.warn(`[office-engine] ${SOURCE_DIR} is not checked out; not generating the mirror`);
    return;
  }
  const { changes } = syncOfficeEngine({ root });
  if (changes.length > 0) console.log(`[office-engine] regenerated ${changes.length} mirror file(s) for tests`);
}
