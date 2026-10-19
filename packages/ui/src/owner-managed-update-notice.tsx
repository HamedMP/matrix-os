import type { CSSProperties } from "react";

/** The same owner-confirmed update policy across Web and Electron System views. */
export function OwnerManagedUpdateNotice({ className, style }: { className?: string; style?: CSSProperties }) {
  return <p role="status" className={className} style={style}>This Preview stays on the version confirmed by its owner.</p>;
}
