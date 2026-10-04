import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** External evidence belongs to its caller; only fixture-owned temporary captures are removed. */
export function createEvidenceDirectory(externalPath?: string) {
  const path = externalPath ?? mkdtempSync(join(tmpdir(), "matrix-settings-evidence-"));
  mkdirSync(path, { recursive: true });
  return { path, cleanup() { if (!externalPath) rmSync(path, { recursive: true, force: true }); } };
}
