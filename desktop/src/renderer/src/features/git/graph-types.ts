// Client-side contracts for the gateway git log/diff endpoints
// (packages/gateway/src/git-log.ts). Bounded zod mirrors of the server
// shapes; unknown or oversized payloads fail closed to a generic error.
import { z } from "zod/v4";

export const CommitSummarySchema = z.object({
  sha: z.string().min(4).max(64),
  parents: z.array(z.string().max(64)).max(8),
  author: z.string().max(200),
  timestamp: z.string().max(64),
  subject: z.string().max(2_000),
  refs: z.array(z.string().max(200)).max(50),
  tags: z.array(z.string().max(200)).max(50),
  head: z.boolean(),
});

export const CommitDiffFileSchema = z.object({
  path: z.string().min(1).max(4_096),
  oldPath: z.string().max(4_096).nullable(),
  status: z.string().min(1).max(4),
  additions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
  binary: z.boolean(),
  patch: z.string().max(200_000).nullable(),
  truncated: z.boolean(),
});

export const CommitListResponseSchema = z.object({
  commits: z.array(CommitSummarySchema).max(500),
  nextCursor: z.string().max(16).nullable(),
});

export const CommitDiffResponseSchema = z.object({
  files: z.array(CommitDiffFileSchema).max(500),
  truncated: z.boolean(),
});

export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type CommitDiffFile = z.infer<typeof CommitDiffFileSchema>;

export interface CommitDiffState {
  sha: string;
  files: CommitDiffFile[];
  truncated: boolean;
}
