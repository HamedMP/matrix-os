import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  handle: string;
  aiHandle: string;
  displayName: string;
  createdAt: string;
}

const EMPTY_IDENTITY: Identity = {
  handle: "",
  aiHandle: "",
  displayName: "",
  createdAt: "",
};

export function deriveAiHandle(handle: string): string {
  return `${handle}_ai`;
}

export function loadHandle(homePath: string): Identity {
  const path = join(homePath, "system", "handle.json");
  if (!existsSync(path)) return { ...EMPTY_IDENTITY };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return {
      handle: data.handle ?? "",
      aiHandle: data.aiHandle ?? "",
      displayName: data.displayName ?? "",
      createdAt: data.createdAt ?? "",
    };
  } catch {
    return { ...EMPTY_IDENTITY };
  }
}

export function saveIdentity(homePath: string, identity: Identity): void {
  const path = join(homePath, "system", "handle.json");
  writeFileSync(path, JSON.stringify(identity, null, 2) + "\n");
}
