// CSI (colours, cursor moves, erase), OSC (titles, links) and other escape
// sequences, plus stray C0 controls other than tab.
const ESCAPE_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_][^\u001b]*\u001b\\|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** The text a terminal row shows, without the escape codes that style it. */
export function visibleTerminalText(row: string): string {
  return row.replace(ESCAPE_SEQUENCES, "");
}
