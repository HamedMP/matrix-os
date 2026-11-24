// Vitest global setup: tests under tests/default-apps/** import the office apps,
// which import home/apps/_shared/office-engine. That copy of packages/office/src
// is generated and git-ignored, so regenerate it before any test file loads.
// Up-to-date files are left untouched, so this costs a directory comparison.
import { syncOfficeEngine } from "../../scripts/sync-office-engine.mjs";

export default function setup(): void {
  const { changes } = syncOfficeEngine();
  if (changes.length > 0) console.log(`[office-engine] regenerated ${changes.length} mirror file(s) for tests`);
}
