import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

// Callers hold the checkout launcher lock. One reserved temporary name bounds
// crash leftovers; each write reconciles it without following symlinks.
export function writeParityState(path, state, { rename = renameSync } = {}) {
  const temporary = `${path}.next`;
  try {
    const info = lstatSync(temporary);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe parity state temporary file");
    rmSync(temporary);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    rename(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) rmSync(temporary, { force: true });
  }
}
