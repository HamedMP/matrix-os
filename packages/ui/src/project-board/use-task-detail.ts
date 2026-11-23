"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectBoardClient } from "./client.js";
import type { TaskActivity, TaskComment } from "./types.js";

export type TimelineEntry =
  | { kind: "comment"; key: string; at: string; comment: TaskComment }
  | { kind: "activity"; key: string; at: string; activity: TaskActivity };

/** One timeline, oldest first: comments and activity interleaved by time. */
export function mergeTimeline(comments: readonly TaskComment[], activity: readonly TaskActivity[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, key: `c:${comment.id}`, at: comment.createdAt, comment })),
    ...activity.map((entry) => ({ kind: "activity" as const, key: `a:${entry.seq}`, at: entry.at, activity: entry })),
  ];
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === b.kind ? 0 : a.kind === "activity" ? -1 : 1));
}

/** Comments and activity for the open task, refetched on that task's change signals. */
export function useTaskDetail(client: ProjectBoardClient, taskId: string) {
  const [data, setData] = useState<{ taskId: string; comments: readonly TaskComment[]; activity: readonly TaskActivity[] } | null>(null);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([client.listComments(taskId), client.listActivity(taskId)]).then(([comments, activity]) => {
      if (!live) return;
      setData({ taskId, comments, activity });
      setError(false);
    }, (failure: unknown) => {
      if (!live) return;
      console.warn("[project-board] task timeline could not be loaded", failure instanceof Error ? failure.name : typeof failure);
      setError(true);
    });
    return () => { live = false; };
  }, [client, taskId, refreshKey]);

  useEffect(() => client.subscribe((event) => {
    if (event.type === "board.resync" || event.taskId === taskId) setRefreshKey((key) => key + 1);
  }), [client, taskId]);

  const current = data?.taskId === taskId ? data : null;
  const timeline = useMemo(() => (current ? mergeTimeline(current.comments, current.activity) : []), [current]);
  return {
    status: current ? "ready" as const : error ? "error" as const : "loading" as const,
    timeline,
    retry: useCallback(() => setRefreshKey((key) => key + 1), []),
  };
}
