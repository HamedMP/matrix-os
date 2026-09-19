import type { TerminalScrollState } from "@matrix-os/contracts";
interface ScrollTerminal {
  buffer: { active: { baseY: number; viewportY: number } };
  scrollToLine: (line: number) => void;
  onScroll: (listener: () => void) => { dispose(): void };
}

/** One native rail for xterm history plus the locally clipped canonical grid. */
export function createTerminalScrollbar(options: {
  host: HTMLElement;
  root: HTMLElement;
  terminal: ScrollTerminal;
  getCellHeight: () => number;
  getTailHeight?: () => number;
  onPan: () => void;
  nativeHistory?: { getState(): TerminalScrollState | null; scrollTo(line: number): void };
}) {
  const { host, root, terminal } = options;
  const parent = host.parentElement!;
  const oldPosition = parent.style.position;
  const positioned = getComputedStyle(parent).position === "static" || !getComputedStyle(parent).position;
  if (positioned) parent.style.position = "relative";
  const oldScrollbarWidth = host.style.scrollbarWidth;
  host.style.scrollbarWidth = "auto";
  host.dataset.terminalUnifiedScrollbar = "true";
  const style = document.createElement("style");
  style.textContent = `
    [data-terminal-unified-scrollbar]::-webkit-scrollbar { width: 0; height: 6px; }
    [data-terminal-unified-scrollbar]::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, currentColor 34%, transparent); border-radius: 999px;
    }
    [data-terminal-unified-scrollbar]::-webkit-scrollbar-track { background: transparent; }
  `;
  parent.append(style);
  const hidden = [...root.querySelectorAll<HTMLElement>(".xterm-scrollable-element > .scrollbar.vertical")]
    .slice(0, 2).map((element) => ({ element, display: element.style.display }));
  for (const { element } of hidden) element.style.display = "none";
  const rail = document.createElement("div");
  rail.dataset.terminalScrollbar = "content";
  rail.setAttribute("aria-label", "Terminal history");
  rail.tabIndex = -1;
  Object.assign(rail.style, {
    position: "absolute", width: "12px", overflowY: "scroll", overflowX: "hidden",
    scrollbarWidth: "thin", scrollbarColor: "color-mix(in srgb, currentColor 34%, transparent) transparent",
    overscrollBehavior: "contain", zIndex: "1",
  });
  const spacer = document.createElement("div");
  spacer.style.width = "1px";
  spacer.style.pointerEvents = "none";
  rail.append(spacer);
  parent.append(rail);
  let syncing = false;
  let synchronizedTop = 0;
  const metrics = () => {
    const native = options.nativeHistory?.getState();
    return ({
    cell: native ? Math.max(options.getCellHeight(), host.clientHeight / native.rows) : options.getCellHeight(),
    pan: Math.max(0, (options.getTailHeight?.() ?? host.scrollHeight) - host.clientHeight),
    history: native
      ? native.above + native.below
      : terminal.buffer.active.baseY,
    });
  };
  const sync = () => {
    if (syncing) return;
    // The rail event may still be queued behind an earlier host scroll.
    // Apply that gesture before reflecting terminal state back into the rail.
    if (Math.abs(rail.scrollTop - synchronizedTop) >= 0.01) onScroll();
    const { cell, pan, history } = metrics();
    if (!Number.isFinite(cell) || cell <= 0) return;
    Object.assign(rail.style, {
      left: `${host.offsetLeft + host.clientWidth - 12}px`, top: `${host.offsetTop}px`,
      height: `${host.clientHeight}px`, display: history * cell + pan > 0 ? "block" : "none",
    });
    spacer.style.height = `${host.clientHeight + history * cell + pan}px`;
    rail.scrollTop = (options.nativeHistory?.getState()?.above ?? terminal.buffer.active.viewportY) * cell + host.scrollTop;
    synchronizedTop = rail.scrollTop;
  };
  const onScroll = () => {
    if (syncing || Math.abs(rail.scrollTop - synchronizedTop) < 0.01) return;
    const { cell, pan, history } = metrics();
    if (!Number.isFinite(cell) || cell <= 0) return;
    const top = Math.max(0, Math.min(history * cell + pan, rail.scrollTop));
    const line = Math.min(history, Math.floor(top / cell));
    syncing = true;
    try {
      if (options.nativeHistory?.getState()) options.nativeHistory.scrollTo(line);
      else terminal.scrollToLine(line);
      host.scrollTop = Math.min(Math.max(0, host.scrollHeight - host.clientHeight), top - line * cell);
      options.onPan();
      synchronizedTop = rail.scrollTop;
    } finally { syncing = false; }
  };
  rail.addEventListener("scroll", onScroll);
  host.addEventListener("scroll", sync);
  const subscription = terminal.onScroll(sync);
  return {
    sync,
    dispose() {
      subscription.dispose();
      rail.removeEventListener("scroll", onScroll);
      host.removeEventListener("scroll", sync);
      rail.remove();
      style.remove();
      delete host.dataset.terminalUnifiedScrollbar;
      host.style.scrollbarWidth = oldScrollbarWidth;
      for (const { element, display } of hidden) element.style.display = display;
      if (positioned) parent.style.position = oldPosition;
    },
  };
}
