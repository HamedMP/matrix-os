import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_SOUL_CHARS = 2000;

function loadFile(homePath: string, ...segments: string[]): string {
  const filePath = join(homePath, ...segments);
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8");
}

export function loadSoul(homePath: string): string {
  const content = loadFile(homePath, "system", "soul.md");
  if (content.length > MAX_SOUL_CHARS) {
    return content.slice(0, MAX_SOUL_CHARS);
  }
  return content;
}

export function loadIdentity(homePath: string): string {
  return loadFile(homePath, "system", "identity.md");
}

export function loadUser(homePath: string): string {
  return loadFile(homePath, "system", "user.md");
}

export function loadBootstrap(homePath: string): string {
  return loadFile(homePath, "system", "bootstrap.md");
}
