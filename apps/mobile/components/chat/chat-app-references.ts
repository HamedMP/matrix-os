import { resolveChatAppReference } from "@matrix-os/contracts";

// A fence opens a block of code that runs to its closing fence, or to the end
// of a reply that is still streaming.
const FENCED_CODE = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|(?![\s\S]))/gm;
// Inline code and link targets: the two places desktop looks for an app's path.
const INLINE_CODE_OR_LINK = /`([^`\n]+)`|\[[^\]\n]+\]\(([^)\s]+)\)/g;
const APPS_FOLDER = /(?:^|\/)apps\//;

/**
 * The link targets and inline code in a reply that point into the apps folder,
 * in reading order. Cheap enough to run on every reply before the apps
 * catalog is asked for.
 */
export function replyAppCandidates(text: string): string[] {
  if (!text.includes("apps/")) return [];
  const candidates: string[] = [];
  for (const match of text.replace(FENCED_CODE, "\n").matchAll(INLINE_CODE_OR_LINK)) {
    const reference = (match[1] ?? match[2] ?? "").trim();
    if (APPS_FOLDER.test(reference) && !/^https?:/i.test(reference)) candidates.push(reference);
  }
  return candidates;
}

/** The catalog apps a reply refers to: each once, in the order the reply mentions them. */
export function findReplyApps<T extends { slug: string; path?: string }>(
  text: string,
  apps: readonly T[],
  options: { allowRelative: boolean },
): T[] {
  const found: T[] = [];
  for (const candidate of replyAppCandidates(text)) {
    const app = resolveChatAppReference(candidate, apps, options);
    if (app && !found.includes(app)) found.push(app);
  }
  return found;
}
