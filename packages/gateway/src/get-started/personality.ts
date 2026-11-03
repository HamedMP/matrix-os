import {
  GET_STARTED_PERSONALITIES,
  renderGetStartedSoulSection,
  replaceGetStartedSoulSection,
  type GetStartedAnswers,
  type GetStartedBot,
} from "@matrix-os/contracts";
import { readOwnerSoul } from "../bots/owner-personality.js";
import { writeOwnerSoulAtomic } from "../bots/owner-personality-write.js";
import { withPinnedSystemDir } from "./owner-system-dir.js";

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

/**
 * Fills the profile's name lines through the pinned owner `system` directory, like the owner
 * SOUL writer: the read and the atomic commit both resolve through it, so a replaced or linked
 * directory can never redirect the write. A missing file, a link the owner placed, or anything
 * but a modest regular file is left alone.
 */
async function updateProfile(homePath: string, file: string, fields: Record<string, string>): Promise<void> {
  await withPinnedSystemDir(homePath, async (dir) => {
    const entry = await dir.lstat(file);
    if (!entry || !entry.isFile() || entry.size > MAX_PROFILE_BYTES) return;
    const before = await dir.readFile(file, MAX_PROFILE_BYTES);
    if (before === null) return;
    const after = setProfileFields(before, fields);
    if (after !== before) await dir.writeAtomic(file, after, entry.mode & 0o777);
  });
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
