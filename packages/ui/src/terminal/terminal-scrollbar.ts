import type { TerminalScrollState } from "@matrix-os/contracts";
import { NATIVE_HISTORY_RESPONSE_BUDGET_MS } from "./terminal-native-history";
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
  onPan: (atBottom: boolean) => void;
  onReceiptFailed?: () => void;
  nativeHistory?: {
    getState(): TerminalScrollState | null;
    scrollTo(line: number): boolean | void;
    cancelScroll?(): void;
    getSourceIdentity?(): object;
  };
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
  let historyFrame: number | null = null;
  let receiptTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTarget: { line: number; pan: number; native: boolean; source: object | undefined; deadline: number } | null = null;
  let disposed = false;
  let ignoreNextGesture = false;
  const cancelPending = () => {
    if (historyFrame !== null) cancelAnimationFrame(historyFrame);
    if (receiptTimer !== null) clearTimeout(receiptTimer);
    if (pendingTarget?.native) options.nativeHistory?.cancelScroll?.();
    historyFrame = null;
    receiptTimer = null;
    pendingTarget = null;
  };
  const abandonPending = () => {
    cancelPending();
    ignoreNextGesture = true;
    options.onReceiptFailed?.();
  };
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
  const receiptIsCurrent = (receipt: NonNullable<typeof pendingTarget>) => !disposed
    && receipt.native === Boolean(options.nativeHistory?.getState())
    && receipt.source === options.nativeHistory?.getSourceIdentity?.()
    && receipt.line <= metrics().history
    && receipt.pan <= Math.max(0, host.scrollHeight - host.clientHeight)
    && Date.now() < receipt.deadline;
  const receiptIsAcknowledged = (receipt: NonNullable<typeof pendingTarget>) =>
    (options.nativeHistory?.getState()?.above ?? terminal.buffer.active.viewportY) === receipt.line
    && Math.abs(host.scrollTop - receipt.pan) < 0.01;
  const sync = () => {
    if (disposed || syncing) return;
    if (pendingTarget && !receiptIsCurrent(pendingTarget)) abandonPending();
    // The rail event may still be queued behind an earlier host scroll.
    // Apply that gesture before reflecting terminal state back into the rail.
    const ignoreGesture = ignoreNextGesture;
    ignoreNextGesture = false;
    if (!ignoreGesture && Math.abs(rail.scrollTop - synchronizedTop) >= 0.01) onScroll();
    const { cell, pan, history } = metrics();
    if (!Number.isFinite(cell) || cell <= 0) return;
    Object.assign(rail.style, {
      left: `${host.offsetLeft + host.clientWidth - 12}px`, top: `${host.offsetTop}px`,
      height: `${host.clientHeight}px`, display: history * cell + pan > 0 ? "block" : "none",
    });
    spacer.style.height = `${host.clientHeight + history * cell + pan}px`;
    const above = options.nativeHistory?.getState()?.above ?? terminal.buffer.active.viewportY;
    if (pendingTarget && !receiptIsAcknowledged(pendingTarget)) return;
    cancelPending();
    rail.scrollTop = above * cell + host.scrollTop;
    synchronizedTop = rail.scrollTop;
  };
  const onScroll = () => {
    if (disposed || syncing || Math.abs(rail.scrollTop - synchronizedTop) < 0.01) return;
    const { cell, pan, history } = metrics();
    if (!Number.isFinite(cell) || cell <= 0) return;
    const top = Math.max(0, Math.min(history * cell + pan, rail.scrollTop));
    const line = Math.min(history, Math.floor(top / cell));
    cancelPending();
    syncing = true;
    const receipt = pendingTarget = {
      line, pan: Math.min(Math.max(0, host.scrollHeight - host.clientHeight), top - line * cell),
      native: Boolean(options.nativeHistory?.getState()), source: options.nativeHistory?.getSourceIdentity?.(),
      deadline: Date.now() + NATIVE_HISTORY_RESPONSE_BUDGET_MS,
    };
    receiptTimer = setTimeout(() => {
      if (disposed || pendingTarget !== receipt) return;
      abandonPending();
      sync();
    }, NATIVE_HISTORY_RESPONSE_BUDGET_MS);
    let rejected = false;
    try {
      if (receipt.native) rejected = options.nativeHistory!.scrollTo(line) === false;
      else {
        terminal.scrollToLine(line);
        // xterm can publish history before its queued viewport dimensions are
        // current. Reapply the latest absolute target once that frame settles.
        if (historyFrame !== null) cancelAnimationFrame(historyFrame);
        historyFrame = requestAnimationFrame(() => {
          if (disposed || pendingTarget !== receipt) return;
          historyFrame = null;
          if (!receiptIsCurrent(receipt)) {
            abandonPending();
            sync();
            return;
          }
          terminal.scrollToLine(receipt.line);
        });
      }
      host.scrollTop = Math.min(Math.max(0, host.scrollHeight - host.clientHeight), top - line * cell);
      options.onPan(top >= history * cell + pan - 0.01);
      synchronizedTop = rail.scrollTop;
    } finally { syncing = false; }
    if (rejected) { abandonPending(); sync(); }
  };
  rail.addEventListener("scroll", onScroll);
  host.addEventListener("scroll", sync);
  const subscription = terminal.onScroll(sync);
  return {
    sync, cancelPending,
    hasPendingIntent: () => pendingTarget !== null && receiptIsCurrent(pendingTarget) && !receiptIsAcknowledged(pendingTarget),
    dispose() {
      disposed = true;
      cancelPending();
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
