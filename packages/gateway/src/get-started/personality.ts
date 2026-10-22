import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  GET_STARTED_PERSONALITIES,
  renderGetStartedSoulSection,
  replaceGetStartedSoulSection,
  type GetStartedAnswers,
  type GetStartedBot,
} from "@matrix-os/contracts";
import { readOwnerSoul } from "../bots/owner-personality.js";
import { writeOwnerSoulAtomic } from "../bots/owner-personality-write.js";
import { writeUtf8FileAtomic } from "../shell/atomic-write.js";

// Spec 635, Section 7. Writes the owner's choices into the one owner SOUL
// (`system/soul.md`) that the kernel, Matrix Bot and managed chats all read,
// replacing only the managed section. identity.md and user.md get their name
// lines filled in place. Callers hold the owner-file mutation lock.

const MAX_PROFILE_BYTES = 64 * 1024;

/** Replaces the value of `- **Field:** …` lines that exist; never adds lines or creates files. */
export function setProfileFields(text: string, fields: Record<string, string>): string {
  return text.split("\n").map((line) => {
    const match = /^- \*\*([^*]+):\*\*/.exec(line);
    const value = match?.[1] ? fields[match[1]] : undefined;
    return value === undefined ? line : `- **${match![1]}:** ${value}`;
  }).join("\n");
}

/** Missing, or a link the owner placed: either way the profile is left alone. */
function isSkippable(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP");
}

/** Like the owner SOUL reader: refuses a symlinked system directory or file, and never reads through a link. */
async function updateProfile(homePath: string, file: string, fields: Record<string, string>): Promise<void> {
  const system = join(homePath, "system");
  const parent = await lstat(system);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("UnsafeProfileDirectory");
  const path = join(system, file);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: unknown) {
    if (isSkippable(error)) return;
    throw error;
  }
  let before: string;
  let mode: number;
  try {
    const stats = await handle.stat();
    // Owner profile files are regular files of modest size; anything else is left alone.
    if (!stats.isFile() || stats.size > MAX_PROFILE_BYTES) return;
    mode = stats.mode & 0o777;
    before = await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
  const after = setProfileFields(before, fields);
  // The atomic rename replaces the path itself; it never writes through a link.
  if (after !== before) await writeUtf8FileAtomic(path, after, mode);
}

export async function applyGetStartedPersonality(homePath: string, answers: GetStartedAnswers & { bot: GetStartedBot }): Promise<void> {
  const soul = await readOwnerSoul(homePath);
  const next = replaceGetStartedSoulSection(soul, renderGetStartedSoulSection(answers));
  // The shared writer enforces the 16 KiB SOUL limit, control characters and no-follow writes.
  if (next !== soul) await writeOwnerSoulAtomic(homePath, next);
  const vibe = GET_STARTED_PERSONALITIES.find((personality) => personality.id === answers.bot.personality)?.label;
  await updateProfile(homePath, "identity.md", { Name: answers.bot.name, ...(vibe ? { Vibe: vibe } : {}) });
  if (answers.name) await updateProfile(homePath, "user.md", { Name: answers.name, "What to call them": answers.name });
}
