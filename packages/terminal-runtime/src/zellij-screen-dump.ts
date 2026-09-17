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
