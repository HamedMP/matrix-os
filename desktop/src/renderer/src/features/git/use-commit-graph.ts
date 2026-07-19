// Data hook for the commit DAG panel. Component-local state (no global
// store): the commit window is hard-capped, stale responses are dropped via
// request sequencing, and a 404 from the log endpoint marks the gateway as
// unsupported so the panel can degrade to the classic branches/PRs view.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppError, type AppErrorCategory } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import {
  CommitDiffResponseSchema,
  CommitListResponseSchema,
  type CommitDiffState,
  type CommitSummary,
} from "./graph-types";

const PAGE_SIZE = 200;
export const MAX_COMMITS = 2_000;

export type CommitGraphStatus = "idle" | "loading" | "ready" | "error";

export interface CommitGraphController {
  /** null = unknown (first load in flight), false = gateway too old. */
  supported: boolean | null;
  status: CommitGraphStatus;
  commits: CommitSummary[];
  nextCursor: string | null;
  capped: boolean;
  error: AppErrorCategory | null;
  loadingMore: boolean;
  selectedSha: string | null;
  diff: CommitDiffState | null;
  diffStatus: CommitGraphStatus;
  diffError: AppErrorCategory | null;
  refresh(): void;
  loadMore(): void;
  selectCommit(sha: string | null): void;
}

function categoryOf(err: unknown): AppErrorCategory {
  return err instanceof AppError ? err.category : "server";
}

export function useCommitGraph(api: ApiClient | null, projectSlug: string): CommitGraphController {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<CommitGraphStatus>("idle");
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<AppErrorCategory | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [diff, setDiff] = useState<CommitDiffState | null>(null);
  const [diffStatus, setDiffStatus] = useState<CommitGraphStatus>("idle");
  const [diffError, setDiffError] = useState<AppErrorCategory | null>(null);
  const listSeq = useRef(0);
  const diffSeq = useRef(0);

  const capped = commits.length >= MAX_COMMITS;

  const fetchPage = useCallback(
    async (cursor: string | null, seq: number) => {
      if (!api) return;
      const query = cursor ? `?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}` : `?limit=${PAGE_SIZE}`;
      const res = await api.get<{ commits?: unknown; nextCursor?: unknown }>(
        `/api/projects/${projectSlug}/commits${query}`,
      );
      const parsed = CommitListResponseSchema.safeParse(res);
      if (!parsed.success) {
        console.warn("[git-graph] malformed commits response");
        throw new AppError("server");
      }
      if (seq !== listSeq.current) return;
      setCommits((prev) => {
        const merged = cursor ? [...prev, ...parsed.data.commits] : parsed.data.commits;
        return merged.slice(0, MAX_COMMITS);
      });
      setNextCursor(parsed.data.nextCursor);
      setSupported(true);
      setStatus("ready");
      setError(null);
    },
    [api, projectSlug],
  );

  const loadInitial = useCallback(
    async (seq: number) => {
      if (!api) return;
      setStatus("loading");
      setError(null);
      try {
        await fetchPage(null, seq);
      } catch (err: unknown) {
        if (seq !== listSeq.current) return;
        if (err instanceof AppError && err.category === "notFound") {
          // Older gateway without the log endpoint: hide the DAG surface.
          setSupported(false);
          setStatus("idle");
          return;
        }
        setSupported(true);
        setStatus("error");
        setError(categoryOf(err));
      }
    },
    [api, fetchPage],
  );

  useEffect(() => {
    const seq = ++listSeq.current;
    diffSeq.current += 1;
    setSupported(api ? null : false);
    setStatus("idle");
    setCommits([]);
    setNextCursor(null);
    setError(null);
    setLoadingMore(false);
    setSelectedSha(null);
    setDiff(null);
    setDiffStatus("idle");
    setDiffError(null);
    void loadInitial(seq);
  }, [api, projectSlug, loadInitial]);

  const loadMore = useCallback(() => {
    if (!api || !nextCursor || loadingMore || capped) return;
    const seq = listSeq.current;
    setLoadingMore(true);
    void fetchPage(nextCursor, seq)
      .catch((err: unknown) => {
        if (seq !== listSeq.current) return;
        setError(categoryOf(err));
      })
      .finally(() => {
        if (seq !== listSeq.current) return;
        setLoadingMore(false);
      });
  }, [api, nextCursor, loadingMore, capped, fetchPage]);

  const selectCommit = useCallback(
    (sha: string | null) => {
      const seq = ++diffSeq.current;
      setSelectedSha(sha);
      setDiff(null);
      setDiffError(null);
      if (!sha || !api) {
        setDiffStatus("idle");
        return;
      }
      setDiffStatus("loading");
      void api
        .get<{ files?: unknown; truncated?: unknown }>(`/api/projects/${projectSlug}/commits/${sha}/diff`)
        .then((res) => {
          const parsed = CommitDiffResponseSchema.safeParse(res);
          if (seq !== diffSeq.current) return;
          if (!parsed.success) {
            console.warn("[git-graph] malformed diff response");
            setDiffStatus("error");
            setDiffError("server");
            return;
          }
          setDiff({ sha, files: parsed.data.files, truncated: parsed.data.truncated });
          setDiffStatus("ready");
        })
        .catch((err: unknown) => {
          if (seq !== diffSeq.current) return;
          setDiffStatus("error");
          setDiffError(categoryOf(err));
        });
    },
    [api, projectSlug],
  );

  const refresh = useCallback(() => {
    const seq = ++listSeq.current;
    // Any in-flight load-more is now stale; its stale-guarded finally will
    // not run, so clear the spinner here.
    setLoadingMore(false);
    void loadInitial(seq);
  }, [loadInitial]);

  return {
    supported,
    status,
    commits,
    nextCursor,
    capped,
    error,
    loadingMore,
    selectedSha,
    diff,
    diffStatus,
    diffError,
    refresh,
    loadMore,
    selectCommit,
  };
}
