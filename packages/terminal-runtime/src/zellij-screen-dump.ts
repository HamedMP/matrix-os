/** Remove CLI framing, never trim terminal rows or whitespace. */
export function decodeZellijScreenDump(stdout: string, scrollback: readonly string[] | null | undefined): string {
  // `dump-screen --ansi` ends with SGR reset; the CLI prints one extra LF.
  let ansi = stdout.endsWith("\x1b[m\n") ? stdout.slice(0, -1) : stdout;
  // Zellij 0.44.3 serializes even empty history as SGR reset, then tests
  // string emptiness before appending a separator. Only authoritative empty
  // history lets us remove that synthetic row: blank history is real data.
  if (scrollback?.length === 0 && ansi.startsWith("\x1b[m\n")) {
    ansi = ansi.slice("\x1b[m\n".length);
  }
  return ansi;
}

export function presentZellijSnapshot(ansi: string, viewportRows: number, rows: number): string {
  // Imported legacy snapshots have no structured viewport. Keep their existing
  // replay behavior rather than guessing where their current screen starts.
  if (viewportRows === 0 || viewportRows > rows) return ansi;
  const content = decodeZellijScreenDump(ansi, undefined);
  const padding = rows - viewportRows;
  if (padding === 0) return content;
  // Make room for the unoccupied viewport rows, moving all preceding history
  // (including ambiguous blank history) above the viewport. IND preserves the
  // column, unlike CRLF; CUU then restores the last content row and column.
  const alignment = "\x1bD".repeat(padding) + `\x1b[${padding}A`;
  // Preserve the existing bounded replay if there is no room for alignment;
  // never turn a valid maximum-size snapshot into a protocol rejection.
  if (normalizeTerminalSnapshot(content).length + alignment.length > MAX_TERMINAL_SNAPSHOT_ANSI_BYTES) return content;
  return content + alignment;
}
import { normalizeTerminalSnapshot } from "@matrix-os/contracts";
import { MAX_TERMINAL_SNAPSHOT_ANSI_BYTES } from "./limits.js";
