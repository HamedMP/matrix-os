import { existsSync, cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_HOME = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  "matrixos",
);

const TEMPLATE_DIR = resolve(
  import.meta.dirname ?? ".",
  "..",
  "..",
  "..",
  "home",
);

export function ensureHome(homePath: string = DEFAULT_HOME): string {
  if (existsSync(homePath)) return homePath;

  mkdirSync(homePath, { recursive: true });
  cpSync(TEMPLATE_DIR, homePath, { recursive: true });

  initGit(homePath);

  return homePath;
}

function initGit(dir: string) {
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", [
      "commit",
      "-m",
      "Matrix OS: initial state",
    ], { cwd: dir, stdio: "ignore" });
  } catch {
    // Git not available -- not critical for operation
  }
}
