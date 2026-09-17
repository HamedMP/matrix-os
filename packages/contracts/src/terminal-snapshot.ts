/** Screen dumps contain text rows, unlike the live terminal byte stream. */
export function normalizeTerminalSnapshot(ansi: string): string {
  return ansi.replace(/\r?\n/g, "\r\n");
}
