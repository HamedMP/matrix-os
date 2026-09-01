import { Terminal } from "@xterm/xterm";
import {
  classifyTerminalClipboardShortcut,
  classifyTerminalPointerEvent,
} from "@matrix-os/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useTerminalAppearance } from "../../stores/terminal-appearance";
import { buildTerminalFontStack } from "../../lib/terminal/terminal-fonts";
import type { ActiveAttachment } from "./attach-manager";
import type { ShellSocketState } from "../../lib/shell-socket";
import { getAttachManager } from "./terminal-runtime";
import TerminalLinkContextMenu, { type DesktopTerminalMenuState } from "./TerminalLinkContextMenu";
import {
  DesktopWebLinkProvider,
  activateDesktopTerminalLink,
  copyDesktopTerminalText,
  findDesktopTerminalLinkAtPointer,
  openDesktopTerminalLink,
  resolveDesktopTerminalLink,
  type TerminalLinkEntry,
} from "./terminal-link-actions";
import {
  bracketTerminalPaths,
  MAX_TERMINAL_PASTE_FILE_BYTES,
  readTerminalClipboardFiles,
  safeTerminalUploadFilename,
  terminalPasteFiles,
} from "./terminal-rich-paste";
import { getDesktopTerminalXtermTheme } from "./terminal-appearance";

const GAP_MARKER = "\r\n\x1b[2m── output gap ──\x1b[0m\r\n";

function proposedTerminalDimensions(fit: FitAddon | null, terminal: Terminal): { cols: number; rows: number } {
  // The production add-on exposes proposeDimensions(). Keep a safe fallback
  // for a temporarily unmeasurable host (and lightweight renderer test mocks).
  if (fit && typeof fit.proposeDimensions === "function") {
    return fit.proposeDimensions() ?? { cols: terminal.cols, rows: terminal.rows };
  }
  return { cols: terminal.cols, rows: terminal.rows };
}

function applyTerminalSurfaceTheme(element: HTMLElement | undefined, background: string): void {
  if (!element) return;
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.backgroundColor = background;
  for (const selector of [".xterm-viewport", ".xterm-scrollable-element"]) {
    const surface = element.querySelector<HTMLElement>(selector);
    if (surface) surface.style.backgroundColor = background;
  }
}

function readOwnedDomSelection(host: HTMLElement): string {
  const selection = host.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      !host.contains(range.startContainer)
      || !host.contains(range.endContainer)
      || !host.contains(range.commonAncestorContainer)
    ) {
      return "";
    }
  }
  return selection.toString().replaceAll("\u00a0", " ");
}

interface TerminalViewProps {
  sessionName: string;
  chatId?: string;
  // When false, the xterm stays mounted (buffer preserved) but the live socket
  // is released so only the focused terminal holds a VPS attachment.
  active?: boolean;
  visualScale?: number;
  onRecreate?: () => void;
}

type ClipboardFeedback = {
  sequence: number;
  message: string;
};

function clipboardFailureFeedback(
  current: ClipboardFeedback | null,
  sequence: number,
  message: string,
): ClipboardFeedback {
  return current && current.sequence > sequence ? current : { sequence, message };
}

function clipboardSuccessFeedback(
  current: ClipboardFeedback | null,
  sequence: number,
): ClipboardFeedback | null {
  // Copy and paste execute independently. A success may clear feedback that
  // was already visible when the operation began, but it must not silence a
  // still-running operation that reports its own failure afterward.
  return current && current.sequence > sequence ? current : null;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- This component owns one xterm instance and its coupled attach, resize, link, paste, and teardown lifecycle. Splitting those effects across child components would obscure single-resource ownership; visual theme helpers and menus remain extracted.
export default function TerminalView({
  sessionName,
  chatId,
  active = true,
  visualScale = 1,
  onRecreate,
}: TerminalViewProps) {
  const api = useConnection((state) => state.api);
  const terminalThemeId = useTerminalAppearance((state) => state.themeId);
  const terminalTheme = getDesktopTerminalXtermTheme(terminalThemeId);
  const latestTerminalThemeIdRef = useRef(terminalThemeId);
  latestTerminalThemeIdRef.current = terminalThemeId;
  const hostRef = useRef<HTMLDivElement>(null);
  const [stateSessionName, setStateSessionName] = useState(sessionName);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const attachmentRef = useRef<ActiveAttachment | null>(null);
  const pasteClipboardRef = useRef<() => Promise<void>>(async () => undefined);
  const copyOperationGenerationRef = useRef(0);
  const pasteOperationGenerationRef = useRef(0);
  const clipboardOperationSequenceRef = useRef(0);
  const confirmedSelectionRef = useRef("");
  const confirmedDomSelectionRef = useRef("");
  const visualScaleRef = useRef(visualScale);
  // react-doctor-disable-next-line react-hooks-js/refs, react-doctor/no-ref-current-in-render -- the long-lived xterm pointer listener must read Canvas zoom changes without recreating the terminal instance.
  visualScaleRef.current = visualScale;
  const endedRef = useRef(false);
  const hoveredLinkRef = useRef<TerminalLinkEntry | null>(null);
  const [socketState, setSocketState] = useState<ShellSocketState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [leaseRevoked, setLeaseRevoked] = useState(false);
  const [leaseAttempt, setLeaseAttempt] = useState(0);
  const [terminalContextMenu, setTerminalContextMenu] = useState<DesktopTerminalMenuState | null>(null);
  const closeTerminalContextMenu = useCallback(() => {
    setTerminalContextMenu(null);
    window.requestAnimationFrame(() => termRef.current?.focus());
  }, []);
  const [clipboardFeedback, setClipboardFeedback] = useState<ClipboardFeedback | null>(null);
  const reportClipboardFailure = useCallback((sequence: number, message: string) => {
    setClipboardFeedback((current) => clipboardFailureFeedback(current, sequence, message));
  }, []);
  const reportClipboardSuccess = useCallback((sequence: number) => {
    setClipboardFeedback((current) => clipboardSuccessFeedback(current, sequence));
  }, []);
  const copyTerminalTextWithFeedback = useCallback(async (text: string) => {
    const operation = ++copyOperationGenerationRef.current;
    const feedbackSequence = ++clipboardOperationSequenceRef.current;
    const result = await copyDesktopTerminalText(text);
    if (copyOperationGenerationRef.current !== operation) return result;
    if (result === "success") {
      reportClipboardSuccess(feedbackSequence);
    } else {
      reportClipboardFailure(feedbackSequence, "Clipboard copy failed. Try again.");
    }
    return result;
  }, [reportClipboardFailure, reportClipboardSuccess]);

  useEffect(() => () => {
    copyOperationGenerationRef.current += 1;
    pasteOperationGenerationRef.current += 1;
  }, []);

  if (stateSessionName !== sessionName) {
    setStateSessionName(sessionName);
    confirmedSelectionRef.current = "";
    confirmedDomSelectionRef.current = "";
    endedRef.current = false;
    setSocketState("connecting");
    setExitCode(null);
    setLeaseRevoked(false);
  }

  // xterm lifecycle — mount once, dispose only on real unmount (tab close).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = getDesktopTerminalXtermTheme(latestTerminalThemeIdRef.current);
    const screenReaderMode = navigator.webdriver === true;
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // Playwright needs readable terminal text while WebGL is active.
      screenReaderMode,
      fontSize: 13,
      fontFamily: buildTerminalFontStack("JetBrains Mono", undefined),
      lineHeight: 1.25,
      scrollback: 5000,
      rightClickSelectsWord: false,
      theme,
      linkHandler: {
        activate: activateDesktopTerminalLink,
        hover: (_event, text) => {
          hoveredLinkRef.current = resolveDesktopTerminalLink(text);
        },
        leave: () => {
          hoveredLinkRef.current = null;
        },
      },
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(serialize);
    terminal.open(host);
    confirmedSelectionRef.current = "";
    confirmedDomSelectionRef.current = "";
    const readTerminalSelection = () => (
      readOwnedDomSelection(host)
      || terminal.getSelection()
      || confirmedSelectionRef.current
      || confirmedDomSelectionRef.current
    );
    const selectionDisposable = terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (selection) confirmedSelectionRef.current = selection;
    });
    const onDocumentSelectionChange = () => {
      const selection = readOwnedDomSelection(host);
      if (selection) {
        confirmedDomSelectionRef.current = selection;
        return;
      }
      const documentSelection = host.ownerDocument.getSelection();
      if (documentSelection && !documentSelection.isCollapsed) {
        confirmedDomSelectionRef.current = "";
        confirmedSelectionRef.current = "";
        terminal.clearSelection();
      }
    };
    host.ownerDocument.addEventListener("selectionchange", onDocumentSelectionChange);
    terminal.attachCustomKeyEventHandler((event) => {
      const selection = readTerminalSelection();
      const action = classifyTerminalClipboardShortcut({
        type: event.type as "keydown" | "keyup" | "keypress",
        key: event.key,
        isMac: navigator.platform.startsWith("Mac"),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        hasSelection: Boolean(selection),
      });
      if (!action) return true;
      event.preventDefault();
      if (action === "copy") {
        void copyTerminalTextWithFeedback(selection);
      } else if (action === "paste") {
        void pasteClipboardRef.current();
      } else {
        terminal.selectAll();
      }
      return false;
    });
    applyTerminalSurfaceTheme(terminal.element, theme.background);
    const linkProviderDisposable = terminal.registerLinkProvider(
      new DesktopWebLinkProvider(terminal, (link) => {
        hoveredLinkRef.current = link;
      }),
    );
    const linkAtPointer = (event: MouseEvent): TerminalLinkEntry | null => {
      return findDesktopTerminalLinkAtPointer(
        terminal,
        event.clientX,
        event.clientY,
        hoveredLinkRef.current,
      );
    };
    const onLinkMouseUp = (event: MouseEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      const link = linkAtPointer(event);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0) openDesktopTerminalLink(link);
    };
    const onTerminalPointer = (event: MouseEvent) => {
      if ((event as MouseEvent & { _xtermScaleCorrected?: boolean })._xtermScaleCorrected) return;
      if (event.type === "mousedown" && event.button === 0) {
        confirmedSelectionRef.current = "";
        confirmedDomSelectionRef.current = "";
      }
      const decision = classifyTerminalPointerEvent({
        type: event.type as "mousedown" | "mousemove" | "mouseup",
        button: event.button,
        buttons: event.buttons,
        hasSelection: Boolean(readTerminalSelection()),
      });
      if (decision === "shield-selection") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const scale = Number.isFinite(visualScaleRef.current) && visualScaleRef.current > 0
        ? visualScaleRef.current
        : 1;
      if (scale === 1) return;

      const element = terminal.element ?? host;
      const rect = element.getBoundingClientRect();
      event.stopImmediatePropagation();
      const target = event.target instanceof Element ? event.target : element;
      const synthetic = new MouseEvent(event.type, {
        bubbles: event.bubbles,
        cancelable: event.cancelable,
        composed: event.composed,
        detail: event.detail,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: rect.left + (event.clientX - rect.left) / scale,
        clientY: rect.top + (event.clientY - rect.top) / scale,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        button: event.button,
        buttons: event.buttons,
        relatedTarget: event.relatedTarget,
      });
      Object.defineProperty(synthetic, "_xtermScaleCorrected", { value: true });
      target.dispatchEvent(synthetic);
    };
    const onTerminalContextMenu = (event: MouseEvent) => {
      const link = linkAtPointer(event);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTerminalContextMenu({
        x: event.clientX,
        y: event.clientY,
        link,
        selection: readTerminalSelection(),
      });
    };
    host.addEventListener("mousedown", onTerminalPointer, true);
    host.addEventListener("mousemove", onTerminalPointer, true);
    host.addEventListener("mouseup", onTerminalPointer, true);
    host.addEventListener("mouseup", onLinkMouseUp, true);
    host.addEventListener("contextmenu", onTerminalContextMenu, true);
    try {
      terminal.loadAddon(new WebglAddon());
    } catch (err: unknown) {
      console.warn("[terminal] webgl unavailable:", err instanceof Error ? err.message : String(err));
    }
    fit.fit();
    const cached = getAttachManager().getCachedBuffer(sessionName);
    if (cached) terminal.write(cached);
    termRef.current = terminal;
    fitRef.current = fit;
    serializeRef.current = serialize;

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const proposed = proposedTerminalDimensions(fit, terminal);
        attachmentRef.current?.resize(proposed.cols, proposed.rows);
      });
    });
    observer.observe(host);

    return () => {
      setTerminalContextMenu(null);
      hoveredLinkRef.current = null;
      host.removeEventListener("mousedown", onTerminalPointer, true);
      host.removeEventListener("mousemove", onTerminalPointer, true);
      host.removeEventListener("mouseup", onTerminalPointer, true);
      host.removeEventListener("mouseup", onLinkMouseUp, true);
      host.removeEventListener("contextmenu", onTerminalContextMenu, true);
      host.ownerDocument.removeEventListener("selectionchange", onDocumentSelectionChange);
      linkProviderDisposable.dispose();
      selectionDisposable.dispose();
      confirmedSelectionRef.current = "";
      confirmedDomSelectionRef.current = "";
      observer.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const manager = getAttachManager();
      try {
        manager.cacheBuffer(sessionName, serialize.serialize());
      } catch (err: unknown) {
        console.warn("[terminal] buffer snapshot failed:", err instanceof Error ? err.message : String(err));
      }
      if (manager.activeSessionName === sessionName) manager.detachActive();
      terminal.dispose();
      termRef.current = null;
    };
  }, [copyTerminalTextWithFeedback, sessionName]);

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;
    const theme = getDesktopTerminalXtermTheme(terminalThemeId);
    terminal.options.theme = theme;
    applyTerminalSurfaceTheme(terminal.element, theme.background);
  }, [terminalThemeId]);

  // Attach lifecycle — only the active tab holds the live socket (L4).
  useEffect(() => {
    const terminal = termRef.current;
    const fit = fitRef.current;
    if (!terminal) return;
    if (!active) {
      terminal.blur();
      hoveredLinkRef.current = null;
      setTerminalContextMenu(null);
      return;
    }
    if (endedRef.current) return;

    const manager = getAttachManager();
    const attachment = manager.attach(sessionName, {
      onState: (state) => setSocketState(state),
      onOutput: (data) => terminal.write(data),
      onCanonicalSize: (size) => {
        if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
          terminal.resize(size.cols, size.rows);
        }
      },
      onLeaseRevoked: () => {
        endedRef.current = true;
        setLeaseRevoked(true);
        setSocketState("ended");
      },
      onPresentationReset: () => {
        terminal.reset();
      },
      onGap: () => {
        terminal.clear();
        terminal.write(GAP_MARKER);
      },
      onExit: (code) => {
        endedRef.current = true;
        setExitCode(code);
        setSocketState("ended");
      },
    }, { cols: terminal.cols, rows: terminal.rows }, chatId);
    attachmentRef.current = attachment;
    const dataDisposable = terminal.onData((data) => {
      attachment.write(data);
    });
    const proposed = proposedTerminalDimensions(fit, terminal);
    attachment.resize(proposed.cols, proposed.rows);
    terminal.focus();

    return () => {
      dataDisposable.dispose();
      attachmentRef.current = null;
      if (manager.activeSessionName === sessionName) manager.detachActive();
    };
  }, [sessionName, chatId, active, leaseAttempt]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    let cancelled = false;
    copyOperationGenerationRef.current += 1;
    pasteOperationGenerationRef.current += 1;

    const isCurrentOperation = (
      operation: number,
      attachment: ActiveAttachment | null,
    ) => !cancelled
      && pasteOperationGenerationRef.current === operation
      && attachmentRef.current === attachment;
    const filesForEvent = (event: ClipboardEvent | DragEvent) => terminalPasteFiles(
      "clipboardData" in event ? event.clipboardData : event.dataTransfer,
    );

    const captureFiles = (event: ClipboardEvent | DragEvent) => {
      const files = filesForEvent(event);
      if (files.length === 0) return [];
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return files;
    };

    const uploadAndPaste = async (
      files: ReturnType<typeof terminalPasteFiles>,
      operation = ++pasteOperationGenerationRef.current,
      initiatingAttachment = attachmentRef.current,
      feedbackSequence = ++clipboardOperationSequenceRef.current,
    ) => {
      if (files.some(({ file }) => file.size > MAX_TERMINAL_PASTE_FILE_BYTES)) {
        if (isCurrentOperation(operation, initiatingAttachment)) {
          reportClipboardFailure(feedbackSequence, "Images are limited to 10 MB.");
        }
        return;
      }
      if (!api || !initiatingAttachment) {
        if (isCurrentOperation(operation, initiatingAttachment)) {
          reportClipboardFailure(feedbackSequence, "Image paste is unavailable. Reconnect and try again.");
        }
        return;
      }
      try {
        const paths = await Promise.all(files.map(async ({ file, mimeType }) => {
          const response = await api.postBytes<{ terminalPath?: unknown }>(
            `/api/terminal/sessions/${encodeURIComponent(sessionName)}/paste-assets`,
            file,
            {
              "Content-Type": mimeType,
              "X-Matrix-Filename": safeTerminalUploadFilename(file.name),
            },
            { timeoutMs: 30_000 },
          );
          if (
            typeof response.terminalPath !== "string"
            || !response.terminalPath.startsWith("/home/matrix/home/")
            || /[\u0000\r\n]/.test(response.terminalPath)
          ) {
            throw new Error("invalid terminal paste response");
          }
          return response.terminalPath;
        }));
        if (paths.length === 0 || !isCurrentOperation(operation, initiatingAttachment)) return;
        const payload = bracketTerminalPaths(paths);
        if (payload === "\x1b[200~\x1b[201~") throw new Error("invalid terminal paste paths");
        initiatingAttachment.write(payload);
        reportClipboardSuccess(feedbackSequence);
      } catch (err: unknown) {
        console.warn("[terminal] image paste failed", {
          category: err instanceof DOMException ? err.name : "terminal-paste-error",
        });
        if (isCurrentOperation(operation, initiatingAttachment)) {
          reportClipboardFailure(feedbackSequence, "Image paste failed. Try again.");
        }
      }
    };

    const pasteFromClipboard = async () => {
      const operation = ++pasteOperationGenerationRef.current;
      const feedbackSequence = ++clipboardOperationSequenceRef.current;
      const initiatingAttachment = attachmentRef.current;
      const clipboard = navigator.clipboard;
      if (!clipboard) {
        if (isCurrentOperation(operation, initiatingAttachment)) {
          reportClipboardFailure(feedbackSequence, "Clipboard paste is unavailable. Try again.");
        }
        return;
      }
      const clipboardWithOptionalRead = clipboard as Clipboard & {
        read?: () => Promise<ClipboardItems>;
      };
      if (typeof clipboardWithOptionalRead.read === "function") {
        try {
          const imageFiles = await readTerminalClipboardFiles(clipboardWithOptionalRead);
          if (imageFiles.length > 0) {
            if (!isCurrentOperation(operation, initiatingAttachment)) return;
            await uploadAndPaste(imageFiles, operation, initiatingAttachment, feedbackSequence);
            return;
          }
        } catch (error: unknown) {
          console.warn("[terminal] clipboard image read unavailable", {
            category: error instanceof DOMException ? error.name : "clipboard-error",
          });
        }
      }
      if (!clipboard.readText) {
        if (isCurrentOperation(operation, initiatingAttachment)) {
          reportClipboardFailure(feedbackSequence, "Clipboard paste is unavailable. Try again.");
        }
        return;
      }
      try {
        const text = await clipboard.readText();
        if (!isCurrentOperation(operation, initiatingAttachment) || text.length === 0) return;
        const terminal = termRef.current;
        if (!terminal) return;
        terminal.paste(text);
        reportClipboardSuccess(feedbackSequence);
      } catch (error: unknown) {
        console.warn("[terminal] clipboard text read unavailable", {
          category: error instanceof DOMException ? error.name : "clipboard-error",
        });
        if (isCurrentOperation(operation, initiatingAttachment)) {
          reportClipboardFailure(feedbackSequence, "Clipboard paste failed. Try again.");
        }
      }
    };
    pasteClipboardRef.current = pasteFromClipboard;

    const onPaste = (event: ClipboardEvent) => {
      const files = captureFiles(event);
      if (files.length > 0) void uploadAndPaste(files);
    };
    const onDrag = (event: DragEvent) => {
      captureFiles(event);
    };
    const onDrop = (event: DragEvent) => {
      const files = captureFiles(event);
      if (files.length > 0) void uploadAndPaste(files);
    };

    host.addEventListener("paste", onPaste, { capture: true });
    host.addEventListener("dragenter", onDrag, { capture: true });
    host.addEventListener("dragover", onDrag, { capture: true });
    host.addEventListener("drop", onDrop, { capture: true });
    return () => {
      cancelled = true;
      copyOperationGenerationRef.current += 1;
      pasteOperationGenerationRef.current += 1;
      if (pasteClipboardRef.current === pasteFromClipboard) {
        pasteClipboardRef.current = async () => undefined;
      }
      host.removeEventListener("paste", onPaste, { capture: true });
      host.removeEventListener("dragenter", onDrag, { capture: true });
      host.removeEventListener("dragover", onDrag, { capture: true });
      host.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [active, api, reportClipboardFailure, reportClipboardSuccess, sessionName]);

  const banner = (() => {
    if (leaseRevoked) {
      return {
        text: "Live on another device.",
        action: <Button variant="primary" onClick={() => {
          endedRef.current = false;
          setLeaseRevoked(false);
          setSocketState("connecting");
          setLeaseAttempt((attempt) => attempt + 1);
        }}>Resume here</Button>,
      };
    }
    if (socketState === "fatal") {
      return { text: "This session has ended on your computer.", action: onRecreate ? <Button variant="primary" onClick={onRecreate}>Start new session</Button> : null };
    }
    if (socketState === "ended") {
      return { text: exitCode !== null ? `Session exited (code ${exitCode}).` : "Session ended.", action: onRecreate ? <Button variant="primary" onClick={onRecreate}>Start new session</Button> : null };
    }
    if (socketState === "connection-lost") return { text: "Connection lost. Reconnecting…", action: null };
    return null;
  })();
  const clipboardError = clipboardFeedback?.message ?? null;

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4"
      data-terminal-surface
      style={{ backgroundColor: terminalTheme.background }}
    >
      <div
        ref={hostRef}
        className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-terminal-viewport
        data-selectable
      />
      {clipboardError ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3" aria-live="polite">
          <span className="rounded-md px-3 py-1.5 text-xs" style={{ background: "var(--danger-muted)", color: "var(--danger)" }}>
            {clipboardError}
          </span>
        </div>
      ) : null}
      {active && (socketState === "connecting" || socketState === "reconnecting") ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2" role="status" aria-live="polite">
          <span className="status-pulse rounded-full px-3 py-1 text-xs" style={{ background: "var(--bg-overlay)", color: "var(--text-secondary)" }}>
            {socketState === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
      ) : null}
      {banner ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t px-4 py-2.5" role="status" aria-live="polite" style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}>
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{banner.text}</span>
          {banner.action}
        </div>
      ) : null}
      <TerminalLinkContextMenu
        menu={terminalContextMenu}
        onClose={closeTerminalContextMenu}
        onOpen={openDesktopTerminalLink}
        onCopy={(link) => copyTerminalTextWithFeedback(link.url)}
        onCopySelection={copyTerminalTextWithFeedback}
        onSelectAll={() => termRef.current?.selectAll()}
      />
    </div>
  );
}
