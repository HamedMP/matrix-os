// Virtualized commit DAG: one full-height SVG layer for edges/dots (filtered
// to the visible row window) plus absolutely positioned HTML rows. Fixed row
// height keeps windowing dependency-free. Adapted from SlayZone's
// CommitGraph render model (straight edges per lane, bezier curves across
// lanes, ref pills on tip commits).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { computeGraphLayout, laneColor, type GraphEdge } from "./graph-layout";
import type { CommitSummary } from "./graph-types";
import { relativeTime } from "./relative-time";

export const ROW_HEIGHT = 40;
export const COLUMN_WIDTH = 16;
const DOT_RADIUS = 4;
const MERGE_DOT_OUTER = 6;
const MERGE_DOT_INNER = 2.5;
const GUTTER_PAD = 10;
const OVERSCAN = 8;
const EDGE_BUFFER_ROWS = 4;
const INITIAL_VIEWPORT_HEIGHT = 600;

export function colX(col: number): number {
  return GUTTER_PAD + col * COLUMN_WIDTH + COLUMN_WIDTH / 2;
}

function rowCenterY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function edgePath(edge: GraphEdge, totalRows: number): string {
  const x1 = colX(edge.fromCol);
  const x2 = colX(edge.toCol);
  const y1 = rowCenterY(edge.fromRow);
  const y2 = edge.toRow === -1 ? totalRows * ROW_HEIGHT : rowCenterY(edge.toRow);
  if (edge.fromCol === edge.toCol) {
    return `M${x1},${y1} L${x2},${y2}`;
  }
  const dy = y2 - y1;
  return `M${x1},${y1} C${x1},${y1 + dy * 0.4} ${x2},${y2 - dy * 0.4} ${x2},${y2}`;
}

interface GitGraphProps {
  commits: CommitSummary[];
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  hasMore: boolean;
  capped: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export const GitGraph = memo(function GitGraph({
  commits,
  selectedSha,
  onSelect,
  hasMore,
  capped,
  loadingMore,
  onLoadMore,
}: GitGraphProps) {
  const layout = useMemo(() => computeGraphLayout(commits), [commits]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(INITIAL_VIEWPORT_HEIGHT);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = el.clientHeight;
      if (next > 0) setViewportHeight(next);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalHeight = commits.length * ROW_HEIGHT;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(commits.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  const visibleEdges = useMemo(() => {
    const visStart = Math.max(0, startRow - EDGE_BUFFER_ROWS);
    const visEnd = Math.min(commits.length, endRow + EDGE_BUFFER_ROWS);
    return layout.edges.filter((edge) => {
      const toRow = edge.toRow === -1 ? commits.length : edge.toRow;
      const lo = Math.min(edge.fromRow, toRow);
      const hi = Math.max(edge.fromRow, toRow);
      return hi >= visStart && lo <= visEnd;
    });
  }, [layout, startRow, endRow, commits.length]);

  let maxVisibleCol = 0;
  for (let row = startRow; row < endRow; row += 1) {
    const col = layout.rows[row]?.col ?? 0;
    if (col > maxVisibleCol) maxVisibleCol = col;
  }
  const gutterWidth = colX(maxVisibleCol) + COLUMN_WIDTH / 2 + 4;

  const rows: React.ReactNode[] = [];
  for (let row = startRow; row < endRow; row += 1) {
    const commit = commits[row]!;
    const selected = commit.sha === selectedSha;
    rows.push(
      <button
        key={commit.sha}
        type="button"
        onClick={() => onSelect(commit.sha)}
        aria-pressed={selected}
        className="absolute right-0 flex flex-col justify-center gap-0.5 overflow-hidden px-2 text-left outline-none"
        style={{
          top: row * ROW_HEIGHT,
          left: gutterWidth,
          height: ROW_HEIGHT,
          background: selected ? "var(--bg-selected)" : undefined,
        }}
      >
        <span className="flex min-w-0 items-center gap-1">
          {commit.head ? (
            <span
              className="shrink-0 rounded px-1 py-px text-[10px] font-semibold"
              style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
            >
              HEAD
            </span>
          ) : null}
          {commit.refs.map((ref) => (
            <span
              key={ref}
              className="shrink-0 rounded px-1 py-px text-[10px] font-medium"
              style={{
                background: `color-mix(in srgb, ${laneColor(layout.rows[row]?.col ?? 0)} 18%, transparent)`,
                color: laneColor(layout.rows[row]?.col ?? 0),
              }}
            >
              {ref}
            </span>
          ))}
          {commit.tags.map((tag) => (
            <span
              key={tag}
              className="shrink-0 rounded px-1 py-px text-[10px] font-medium"
              style={{ background: "var(--warning-muted)", color: "var(--warning)" }}
            >
              {tag}
            </span>
          ))}
          <span className="truncate text-xs" style={{ color: "var(--text-primary)" }}>
            {commit.subject}
          </span>
        </span>
        <span className="truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono">{commit.sha.slice(0, 8)}</span>
          {" · "}
          {commit.author}
          {relativeTime(commit.timestamp) ? ` · ${relativeTime(commit.timestamp)}` : ""}
        </span>
      </button>,
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        data-testid="git-graph-scroll"
      >
        <div className="relative" style={{ height: totalHeight }}>
          <svg
            className="pointer-events-none absolute top-0 left-0"
            width={gutterWidth}
            height={totalHeight}
            aria-hidden="true"
          >
            {visibleEdges.map((edge, index) => (
              <path
                key={index}
                d={edgePath(edge, commits.length)}
                stroke={laneColor(edge.colorIndex)}
                strokeWidth={1.5}
                fill="none"
                opacity={0.45}
              />
            ))}
            {commits.slice(startRow, endRow).map((commit, offset) => {
              const row = startRow + offset;
              const col = layout.rows[row]?.col ?? 0;
              const color = laneColor(col);
              if (commit.parents.length > 1) {
                return (
                  <g key={commit.sha}>
                    <circle
                      cx={colX(col)}
                      cy={rowCenterY(row)}
                      r={MERGE_DOT_OUTER}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.5}
                    />
                    <circle cx={colX(col)} cy={rowCenterY(row)} r={MERGE_DOT_INNER} fill={color} />
                  </g>
                );
              }
              return (
                <circle key={commit.sha} cx={colX(col)} cy={rowCenterY(row)} r={DOT_RADIUS} fill={color} />
              );
            })}
          </svg>
          {rows}
        </div>
      </div>
      {hasMore || capped ? (
        <div
          className="flex h-8 shrink-0 items-center justify-center border-t"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          {hasMore ? (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="text-xs font-medium"
              style={{ color: "var(--accent)" }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : (
            <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              Showing the most recent {commits.length.toLocaleString()} commits
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
});
