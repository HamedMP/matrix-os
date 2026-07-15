import type { ReviewSnapshot, ReviewSummary } from "@matrix-os/contracts";

export type ReviewSnapshotFile = ReviewSnapshot["files"]["items"][number];
export type ReviewSnapshotHunk = ReviewSnapshotFile["hunks"][number];
type ReviewSnapshotLine = NonNullable<ReviewSnapshotHunk["lines"]>[number];

export function reviewStatusLabel(status: ReviewSummary["status"]): string {
  return status.replace(/_/g, " ");
}

export function formatHunkRange(hunk: ReviewSnapshot["files"]["items"][number]["hunks"][number]): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function reviewDiffLineMarker(line: ReviewSnapshotLine): string {
  if (line.kind === "add") return "+";
  if (line.kind === "remove") return "-";
  return " ";
}

function reviewDiffLineColor(line: ReviewSnapshotLine): string {
  if (line.kind === "add") return "var(--success)";
  if (line.kind === "remove") return "var(--danger)";
  return "var(--text-secondary)";
}

function reviewDiffOldLine(line: ReviewSnapshotLine): number | null {
  return "oldLine" in line ? line.oldLine : null;
}

function reviewDiffNewLine(line: ReviewSnapshotLine): number | null {
  return "newLine" in line ? line.newLine : null;
}

function reviewDiffLineLabel(line: ReviewSnapshotLine): string {
  const parts = [
    line.kind === "add" ? "Added line" : line.kind === "remove" ? "Removed line" : "Context line",
  ];
  const oldLine = reviewDiffOldLine(line);
  const newLine = reviewDiffNewLine(line);
  if (oldLine !== null) parts.push("old", String(oldLine));
  if (newLine !== null) parts.push("new", String(newLine));
  return parts.join(" ");
}

export function ReviewDiffLines({ lines }: { lines: ReviewSnapshotLine[] }) {
  if (!lines.length) return null;

  return (
    <div
      className="ph-no-capture mx-3 mb-2 min-w-0 overflow-x-auto rounded border font-mono text-xs"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      {lines.map((line, index) => (
        <div
          key={`${line.kind}:${reviewDiffOldLine(line) ?? ""}:${reviewDiffNewLine(line) ?? ""}:${index}`}
          aria-label={reviewDiffLineLabel(line)}
          className="grid min-h-6 grid-cols-[24px_44px_44px_minmax(0,1fr)] items-start gap-2 border-b px-2 py-1 last:border-b-0"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          <span style={{ color: reviewDiffLineColor(line) }}>{reviewDiffLineMarker(line)}</span>
          <span className="text-right tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {reviewDiffOldLine(line) ?? ""}
          </span>
          <span className="text-right tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {reviewDiffNewLine(line) ?? ""}
          </span>
          <code className="min-w-0 whitespace-pre-wrap break-words" style={{ color: "var(--text-primary)" }}>
            {line.content}
          </code>
        </div>
      ))}
    </div>
  );
}
