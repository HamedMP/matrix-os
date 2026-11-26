// What herdr-core is told about a terminal view (spec 2701 layer 6): its
// default colours and its cell size in pixels. The core answers a program's
// colour and cell-size queries from these, and passes theme changes on to
// programs that follow them.
import type { Terminal } from "@xterm/xterm";
import type { TerminalDisplayFacts } from "./attach-manager";

const HEX = /^#[0-9a-f]{6}$/i;

function hex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const full = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : color;
  return HEX.test(full) ? full.toLowerCase() : undefined;
}

/** Only colours written as `#rgb` or `#rrggbb` are passed on; a cell is measured from the drawn grid. */
export function terminalDisplayFacts(
  terminal: Pick<Terminal, "cols" | "rows" | "element">,
  theme: { foreground?: string; background?: string; cursor?: string },
): TerminalDisplayFacts {
  const facts: TerminalDisplayFacts = {};
  const fg = hex(theme.foreground);
  const bg = hex(theme.background);
  const cursor = hex(theme.cursor);
  if (fg) facts.fg = fg;
  if (bg) facts.bg = bg;
  if (cursor) facts.cursor = cursor;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const rect = screen?.getBoundingClientRect();
  if (rect && terminal.cols > 0 && terminal.rows > 0) {
    const width = Math.round(rect.width / terminal.cols);
    const height = Math.round(rect.height / terminal.rows);
    if (width >= 1 && height >= 1 && width <= 1_024 && height <= 1_024) facts.cell = [width, height];
  }
  return facts;
}
