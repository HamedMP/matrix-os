import { vi } from "vitest";
import type {
  BrainCiteView, BrainClaimView, BrainShellClient, BrainSourceView,
} from "../../packages/ui/src/brain/brain-types.js";

export const PROJECT = "proj_db779ebd-56fb-4c55-a253-34add36251b7";

/** Every method rejects until a test gives it an answer. */
export function fakeBrainApi(overrides: Partial<Record<keyof BrainShellClient, (...args: never[]) => unknown>> = {}) {
  const names: (keyof BrainShellClient)[] = [
    "registerGitSource", "syncGit", "gitReceipts", "why", "extract", "claims", "search", "refreshSearch", "timeline",
    "entities", "entity", "entityLinks", "updateAlias", "refreshGraph", "sources", "connectSource", "sourceOptions",
    "updateSource", "removeSource", "syncSource", "sourceReceipts", "brief", "generateBrief", "conflicts", "stale",
    "impact", "mergeSuggestions", "startJob", "job", "jobs", "cancelJob",
  ];
  const api = {} as Record<keyof BrainShellClient, ReturnType<typeof vi.fn>>;
  for (const name of names) {
    api[name] = vi.fn(overrides[name] ?? (() => Promise.reject(apiError("server", "brain_unavailable"))));
  }
  return api as unknown as BrainShellClient & Record<keyof BrainShellClient, ReturnType<typeof vi.fn>>;
}

type BrainTestCategory = "unauthorized" | "offline" | "timeout" | "notFound" | "server" | "misconfigured";

/** A failed transport call as every renderer rejects it: an Error with a category and maybe a gateway code. */
export class BrainTestRequestError extends Error {
  readonly category: BrainTestCategory;
  readonly detail?: string;

  constructor(category: BrainTestCategory, detail?: string) {
    super("Request failed.");
    this.name = "BrainTestRequestError";
    this.category = category;
    if (detail !== undefined) this.detail = detail;
  }
}

export function apiError(category: BrainTestCategory, detail?: string): BrainTestRequestError {
  return new BrainTestRequestError(category, detail);
}

export function cite(label: string, extra: Partial<BrainCiteView> = {}): BrainCiteView {
  return {
    documentId: `doc-${label}`, kind: "pr", provenance: "git_pr", sourceId: "src_1", label, title: `Title ${label}`,
    permalink: `https://github.com/HamedMP/matrix-os/pull/${label.replace("#", "")}`,
    date: "2026-10-01T18:36:35.000Z", revision: 1, ...extra,
  };
}

export function claim(claimId: string, extra: Partial<BrainClaimView> = {}): BrainClaimView {
  return {
    claimId, kind: "decision", label: null, statement: `Statement ${claimId}`, quote: `Quote ${claimId}`,
    spanStart: 0, spanEnd: 10, fields: {}, confidence: "medium", extractor: "rules/v1", revision: 1,
    createdAt: "2026-10-02T12:37:58.384Z", stale: false,
    document: {
      documentId: `doc-${claimId}`, kind: "pr", label: "#2099", title: "Sharing on Web Desktop",
      permalink: "https://github.com/HamedMP/matrix-os/pull/2099", date: "2026-10-01T18:36:35.000Z", revision: 1,
    },
    ...extra,
  };
}

export function source(sourceId: string, extra: Partial<BrainSourceView> = {}): BrainSourceView {
  return {
    sourceId, kind: "linear", label: `Source ${sourceId}`, externalRef: null, status: "active", revision: 3,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", config: null, lastSync: null,
    ...extra,
  };
}

export const COUNTS = { read: 5, written: 3, unchanged: 2, deleted: 0, failed: 0 };
export const FRESH = { caughtUp: true, pendingDocuments: 0, pendingCapped: false };
