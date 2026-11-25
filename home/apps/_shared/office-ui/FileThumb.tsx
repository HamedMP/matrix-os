import { cx } from "./internal";

export type FileThumbKind = "document" | "workbook" | "table" | "folder";

export interface FileThumbProps {
  kind: FileThumbKind;
  /** Small text on the page, such as "csv". */
  tag?: string;
  size?: "sm" | "md";
  className?: string;
}

/** A small typed page: lines for a document, a grid for a workbook or table, a tab for a folder. */
export function FileThumb({ kind, tag, size = "md", className }: FileThumbProps) {
  if (kind === "folder") {
    return (
      <svg className={cx("oui-thumb", "oui-thumb--folder", `oui-thumb--${size}`, className)} viewBox="0 0 32 40" aria-hidden="true">
        <path className="oui-thumb__tab" d="M3 12.5a2.5 2.5 0 012.5-2.5h7l3 3h11a2.5 2.5 0 012.5 2.5v1H3z" />
        <rect className="oui-thumb__folder" x="3" y="15" width="26" height="17" rx="2.5" />
      </svg>
    );
  }
  return (
    <svg className={cx("oui-thumb", `oui-thumb--${kind}`, `oui-thumb--${size}`, className)} viewBox="0 0 32 40" aria-hidden="true">
      <path className="oui-thumb__page" d="M4.5 1.5h16l7 7v28a2 2 0 01-2 2h-21a2 2 0 01-2-2v-33a2 2 0 012-2z" />
      <path className="oui-thumb__fold" d="M20.5 1.5v5a2 2 0 002 2h5" />
      {kind === "document" ? (
        <g className="oui-thumb__ink">
          <rect x="7" y="12" width="11" height="2.2" rx="1.1" className="oui-thumb__strong" />
          <rect x="7" y="17.5" width="18" height="1.4" rx=".7" />
          <rect x="7" y="21" width="18" height="1.4" rx=".7" />
          <rect x="7" y="24.5" width="14" height="1.4" rx=".7" />
          <rect x="7" y="28" width="16" height="1.4" rx=".7" />
        </g>
      ) : (
        <g className="oui-thumb__ink">
          <rect x="7" y="12" width="18" height="4" rx=".8" className="oui-thumb__wash" />
          <path className="oui-thumb__grid" d="M7 16h18M7 20h18M7 24h18M7 28h18M13 12v18M19 12v18" />
          <rect x="6.5" y="11.5" width="19" height="19" rx="1" className="oui-thumb__frame" />
        </g>
      )}
      {tag && (
        <text x="16" y="36" textAnchor="middle" className="oui-thumb__tag">
          {tag}
        </text>
      )}
    </svg>
  );
}
