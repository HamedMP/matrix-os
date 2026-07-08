import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PreviewSessionSummarySchema,
  SafeDisplayStringSchema,
  type PreviewSessionSummary,
} from "@matrix-os/contracts";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";
import type { PreviewRecord } from "../preview-manager.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { CodingAgentPreviewSummaryStore } from "./runtime-summary.js";

type PreviewListResult =
  | { ok: true; previews: PreviewRecord[]; nextCursor: string | null }
  | { ok: false; status: number; error: unknown };

export interface CodingAgentPreviewManager {
  listPreviews(projectSlug: string, input?: unknown): Promise<PreviewListResult>;
  listRecentPreviews?(projectSlug: string, input?: unknown): Promise<PreviewListResult>;
}

export interface CodingAgentPreviewSummaryStoreOptions {
  homePath: string;
  previewManager: CodingAgentPreviewManager;
  projectSlugs?: () => Promise<string[]>;
  ownerId?: string;
  principalOwnerIds?: readonly string[];
  limit?: number;
}

const PREVIEW_SUMMARY_LIMIT = 50;
const PROJECT_SCAN_LIMIT = 50;
const MAX_PREVIEW_SCAN_PAGES = 5;
const MAX_RAW_PREVIEW_SCAN = PREVIEW_SUMMARY_LIMIT * MAX_PREVIEW_SCAN_PAGES;

function ownerIdsFor(options: { ownerId?: string; principalOwnerIds?: readonly string[] }): string[] {
  const ids: string[] = [];
  for (const id of [options.ownerId, ...(options.principalOwnerIds ?? [])]) {
    if (!id || ids.includes(id) || ids.length >= 8) continue;
    ids.push(id);
  }
  return ids;
}

function canReadPreviewSessions(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function safeLabel(value: string): string {
  const label = value.length <= 120 ? value : `${value.slice(0, 117)}...`;
  const parsed = SafeDisplayStringSchema.safeParse(label);
  return parsed.success ? parsed.data : "Preview";
}

function previewStatus(status: PreviewRecord["lastStatus"]): PreviewSessionSummary["status"] {
  if (status === "ok") return "running";
  if (status === "failed") return "failed";
  return "unknown";
}

function localPreviewOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const local = hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("127.");
    return local ? url.origin : undefined;
  } catch (err: unknown) {
    if (err instanceof TypeError) return undefined;
    console.warn("[coding-agents] preview origin parse failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function summaryFromPreview(preview: PreviewRecord): PreviewSessionSummary | null {
  const parsed = PreviewSessionSummarySchema.safeParse({
    id: preview.id,
    label: safeLabel(preview.label),
    status: previewStatus(preview.lastStatus),
    origin: localPreviewOrigin(preview.url),
    updatedAt: preview.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

async function defaultProjectSlugs(homePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(homePath, "projects"), { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return entries
    .filter((entry) => entry.isDirectory() && PROJECT_SLUG_REGEX.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, PROJECT_SCAN_LIMIT + 1);
}

export function createCodingAgentPreviewSummaryStore(
  options: CodingAgentPreviewSummaryStoreOptions,
): CodingAgentPreviewSummaryStore {
  const homePath = resolve(options.homePath);
  const limit = Math.min(Math.max(options.limit ?? PREVIEW_SUMMARY_LIMIT, 1), PREVIEW_SUMMARY_LIMIT);
  const listProjectSlugs = options.projectSlugs ?? (() => defaultProjectSlugs(homePath));
  const ownerIds = ownerIdsFor(options);

  return {
    async listPreviewSessions(principal: RequestPrincipal) {
      if (!canReadPreviewSessions(principal, ownerIds)) {
        return { items: [], hasMore: false, limit };
      }

      const rawProjectSlugs = (await listProjectSlugs()).filter((slug) => PROJECT_SLUG_REGEX.test(slug));
      const projectSlugs = rawProjectSlugs
        .slice(0, PROJECT_SCAN_LIMIT);
      const items: PreviewSessionSummary[] = [];
      let hasMore = rawProjectSlugs.length > PROJECT_SCAN_LIMIT;
      let rawPreviewCount = 0;

      for (const projectSlug of projectSlugs) {
        if (rawPreviewCount >= MAX_RAW_PREVIEW_SCAN) {
          hasMore = true;
          break;
        }
        if (options.previewManager.listRecentPreviews) {
          const result = await options.previewManager.listRecentPreviews(projectSlug, { limit });
          if (!result.ok) continue;
          for (const preview of result.previews) {
            rawPreviewCount += 1;
            const summary = summaryFromPreview(preview);
            if (summary) items.push(summary);
            if (rawPreviewCount >= MAX_RAW_PREVIEW_SCAN) break;
          }
          if (result.nextCursor) hasMore = true;
          continue;
        }
        let cursor: string | null | undefined;
        for (let page = 0; page < MAX_PREVIEW_SCAN_PAGES; page += 1) {
          const result = await options.previewManager.listPreviews(
            projectSlug,
            cursor ? { limit, cursor } : { limit },
          );
          if (!result.ok) break;
          for (const preview of result.previews) {
            rawPreviewCount += 1;
            const summary = summaryFromPreview(preview);
            if (summary) items.push(summary);
            if (rawPreviewCount >= MAX_RAW_PREVIEW_SCAN) break;
          }
          cursor = result.nextCursor;
          if (cursor) hasMore = true;
          if (!cursor || rawPreviewCount >= MAX_RAW_PREVIEW_SCAN) break;
        }
      }

      items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
      return {
        items: items.slice(0, limit),
        hasMore,
        limit,
      };
    },
  };
}
