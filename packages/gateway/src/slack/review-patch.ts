import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { BotIntegrationClient } from "../bots/integration-client.js";

const MAX_FILES = 10;
const MAX_PATCH_BYTES = 14_000;
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z.object({ id: z.number().int().positive().safe(), full_name: z.string().max(256), private: z.boolean() });
const revision = z.object({ sha, repo: repository });
const count = z.number().int().nonnegative().max(100_000);
const metadata = z.object({
  number: z.number().int().positive(), changed_files: z.number().int().min(1).max(MAX_FILES),
  additions: count, deletions: count, head: revision, base: revision
});
const fileSchema = z.object({
  filename: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/),
  status: z.enum(["modified", "added"]), additions: count, deletions: count, changes: count,
  contents_url: z.string().max(4096), patch: z.string().min(1).max(MAX_PATCH_BYTES)
});

export type ReviewRequest = { pullNumber: number; expectedHead?: string };
type ReviewScope = { repositoryId: string; fullName: string; connectionId: string };
export type ReviewPatch = Awaited<ReturnType<typeof readRoutedReviewPatch>>;

export class RoutedPatchUnavailable extends Error {
  constructor() { super("A complete patch for the approved pull request is unavailable."); this.name = "RoutedPatchUnavailable"; }
}

/** A review command in the other mapped channel cannot silently turn into a summary Run. */
export function mentionsPullReview(text: string) {
  return /^\s*(?:(?:<@U[A-Z0-9]+>|@Matrix)[:,]?\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?review\b/i.test(text) && /https:\/\/github\.com\/[^\s/<>]+\/[^\s/<>]+\/pull\//i.test(text);
}

/** Require a review intent and exactly one canonical PR. Slack can wrap the URL in angle brackets. */
export function parseSlackReviewRequest(text: string, fullName: string): ReviewRequest | null {
  if (text.length > 4000 || !mentionsPullReview(text)) return null;
  const message = text.replace(/<(https?:\/\/[^|<>\s]+)\|([^|<>]{1,200})>/gi, (original, url: string, label: string) =>
    /https?:\/\//i.test(label) && label !== url ? original : "<" + url + ">");
  const links = message.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  if (links.length !== 1) return null;
  const match = /^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})$/i.exec(links[0]!);
  if (!match || match[1]!.toLowerCase() !== fullName.toLowerCase() || Number(match[2]) > 2147483647) return null;
  const revisions = message.replace(links[0]!, "").match(/\b[0-9a-f]{40}\b/gi) ?? [];
  if (revisions.length > 1) return null;
  return { pullNumber: Number(match[2]), ...(revisions[0] ? { expectedHead: revisions[0].toLowerCase() } : {}) };
}

/** GitHub can omit or truncate a patch. Require complete hunk and file totals before considering it usable. */
function completeHunks(file: z.infer<typeof fileSchema>): boolean {
  let oldRemaining = 0, newRemaining = 0, added = 0, deleted = 0, hunks = 0;
  for (const line of file.patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      if (oldRemaining || newRemaining) return false;
      oldRemaining = Number(header[1] ?? 1);
      newRemaining = Number(header[2] ?? 1);
      hunks++;
    } else if (!hunks) return false;
    else if (line.startsWith("+")) { added++; newRemaining--; }
    else if (line.startsWith("-")) { deleted++; oldRemaining--; }
    else if (line.startsWith(" ")) { oldRemaining--; newRemaining--; }
    else if (line !== "\\ No newline at end of file") return false;
    if (oldRemaining < 0 || newRemaining < 0) return false;
  }
  return hunks > 0 && !oldRemaining && !newRemaining && added === file.additions && deleted === file.deletions
    && added + deleted === file.changes && file.changes > 0;
}

function hasPinnedFileUrl(file: z.infer<typeof fileSchema>, fullName: string, head: string) {
  const url = URL.parse(file.contents_url);
  if (!url || url.origin !== "https://api.github.com" || url.username || url.password || url.hash || url.search !== '?ref=' + head) return false;
  const segments = file.filename.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return false;
  const prefix = '/repos/' + fullName + '/contents/';
  const path = decodeURIComponent(url.pathname);
  return path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() && path.slice(prefix.length) === file.filename;
}

export async function readRoutedReviewPatch(input: {
  client: Pick<BotIntegrationClient, "inventory" | "call">; ownerId: string; scope: ReviewScope;
  request: ReviewRequest; current(): Promise<boolean>; signal: AbortSignal;
}) {
  const { client, ownerId, scope, request, signal } = input;
  const check = async () => {
    if (signal.aborted || !await input.current() || signal.aborted) throw new RoutedPatchUnavailable();
  };
  await check();
  const connections = (await client.inventory(ownerId, signal)).filter(c => c.service === "github" && c.connectionId === scope.connectionId);
  const account = connections[0];
  if (!account || connections.length !== 1) throw new RoutedPatchUnavailable();
  const call = async (action: "get_pr" | "list_pr_files") => {
    await check();
    const params = { repo: scope.fullName, pullNumber: request.pullNumber, ...(action === "list_pr_files" ? { page: 1, perPage: MAX_FILES } : {}) };
    return (await client.call(ownerId, {
      service: "github", action, read: true, label: account.label,
      connectionId: scope.connectionId, params
    }, signal)).data;
  };
  const readMetadata = async () => {
    const result = metadata.safeParse(await call("get_pr"));
    if (!result.success || result.data.number !== request.pullNumber || request.expectedHead && request.expectedHead !== result.data.head.sha
      || result.data.base.repo.private !== result.data.head.repo.private
      || ![result.data.base, result.data.head].every(ref => String(ref.repo.id) === scope.repositoryId &&
        ref.repo.full_name.toLowerCase() === scope.fullName.toLowerCase())) throw new RoutedPatchUnavailable();
    return result.data;
  };
  const before = await readMetadata();
  const page = z.array(fileSchema).min(1).max(MAX_FILES).safeParse(await call("list_pr_files"));
  if (!page.success || page.data.length !== before.changed_files || new Set(page.data.map(f => f.filename)).size !== before.changed_files
    || !page.data.every(f => completeHunks(f) && hasPinnedFileUrl(f, scope.fullName, before.head.sha))
    || page.data.reduce((a, f) => a + f.additions, 0) !== before.additions || page.data.reduce((a, f) => a + f.deletions, 0) !== before.deletions) {
    throw new RoutedPatchUnavailable();
  }
  const files = page.data.map(({ filename, patch }) => ({ filename, patch }));
  const body = JSON.stringify(files);
  if (Buffer.byteLength(body) > MAX_PATCH_BYTES) throw new RoutedPatchUnavailable();
  const after = await readMetadata();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new RoutedPatchUnavailable();
  await check();
  const url = 'https://github.com/' + scope.fullName + '/pull/' + request.pullNumber;
  return {
    repositoryId: scope.repositoryId, url, head: before.head.sha, base: before.base.sha, files,
    digest: createHash("sha256").update(body).digest("hex")
  };
}
