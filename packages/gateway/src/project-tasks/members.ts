import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BoardMember } from "@matrix-os/contracts/project-tasks";
import type { OwnerScope } from "../state-ops.js";

const MAX_HANDLE_FILE_BYTES = 16 * 1024;
const HANDLE = /^[A-Za-z0-9._-]{1,40}$/;

export function ownerActor(ownerScope: OwnerScope): `user:${string}` {
  return `user:${ownerScope.id.replace(/[^A-Za-z0-9_.:@-]/g, "_").slice(0, 190)}`;
}

/** The owner as a board member, named from `~/system/handle.json` when it is readable. */
export async function readOwnerMember(homePath: string, ownerScope: OwnerScope): Promise<BoardMember> {
  const fallback: BoardMember = { actor: ownerActor(ownerScope), name: "You", handle: "me" };
  const path = join(homePath, "system", "handle.json");
  try {
    if ((await stat(path)).size > MAX_HANDLE_FILE_BYTES) return fallback;
    const data = JSON.parse(await readFile(path, "utf8")) as { handle?: unknown; displayName?: unknown };
    const handle = typeof data.handle === "string" && HANDLE.test(data.handle) ? data.handle : fallback.handle;
    const name = typeof data.displayName === "string" && data.displayName.trim() ? data.displayName.trim().slice(0, 120) : handle;
    return { ...fallback, name, handle };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && !(error instanceof SyntaxError)) {
      console.warn("[project-tasks] owner profile unreadable", code ?? (error instanceof Error ? error.name : typeof error));
    }
    return fallback;
  }
}
