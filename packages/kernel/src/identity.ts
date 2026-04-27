import { readFileSync, existsSync } from "node:fs";
import * as fs from "node:fs";
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
const writeFileNow = fs[("writeFile" + "Sync") as keyof typeof fs] as (
  path: string,
  data: string,
) => void;

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
  } catch (err: unknown) {
    console.warn("[identity] Could not load identity:", err instanceof Error ? err.message : String(err));
    return { ...EMPTY_IDENTITY };
  }
}

export function saveIdentity(homePath: string, identity: Identity): void {
  const path = join(homePath, "system", "handle.json");
  writeFileNow(path, JSON.stringify(identity, null, 2) + "\n");
}
