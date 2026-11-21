import type { ReactNode } from "react";
import { Copy, FileCode2, Folder, Globe, Maximize2, MessagesSquare, Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Tooltip } from "../Tooltip.js";
import { Button } from "../Button.js";
import "./desktop-chat.css";

export type InspectorTool = "files" | "terminal" | "side-chat" | "browser" | "new";
export interface InspectorTabItem { id: string; kind: InspectorTool; label: string; closing?: boolean }
export function ChatInspectorFileHeader({ name, path, expandLabel = "Expand file", onExpand, onCopy, children }: {
  name: string; path: string; expandLabel?: string; onExpand?(): void; onCopy(): Promise<void>; children?: ReactNode;
}) {
  const [copyFailed, setCopyFailed] = useState(false);
  const directory = path.split("/").slice(0, -1).join("/");
  return <header className="desktop-chat-design chat-inspector-file-header"><FileCode2 size={14} aria-hidden/><strong>{name}</strong><span title={directory}>{directory}</span>
    <Tooltip content="Copy path"><Button variant="ghost" size="icon" className="desktop-chat-icon" aria-label={`Copy path ${name}`} onClick={() => {
      setCopyFailed(false); void onCopy().catch((cause: unknown) => { console.warn("[chat-file] Copy failed:", cause instanceof Error ? cause.name : "UnknownError"); setCopyFailed(true); });
    }}><Copy size={14} aria-hidden/></Button></Tooltip>
    {onExpand ? <Tooltip content={expandLabel}><Button variant="ghost" size="icon" className="desktop-chat-icon" aria-label={expandLabel} onClick={onExpand}><Maximize2 size={14} aria-hidden/></Button></Tooltip> : null}
    {copyFailed ? <p role="alert">The path could not be copied. Try again.</p> : null}{children}
  </header>;
}
export function InspectorToolIcon({ kind }: { kind: InspectorTool }) {
  const Icon = kind === "files" ? Folder : kind === "terminal" ? SquareTerminal : kind === "side-chat" ? MessagesSquare : kind === "browser" ? Globe : Plus;
  return <Icon size={14} aria-hidden/>;
}
export function ChatInspectorTabs({ tabs, selectedId, onSelect, onClose, onAdd, addControl, trailing }: {
  tabs: readonly InspectorTabItem[]; selectedId: string; onSelect(id: string): void;
  onClose(id: string): void; onAdd(): void; addControl?: ReactNode; trailing?: ReactNode;
}) {
  return <header className="desktop-chat-design chat-inspector-tabs"><div role="tablist" aria-label="Inspector tabs">
    {tabs.map(tab => <div key={tab.id} className="chat-inspector-tab" data-selected={selectedId === tab.id || undefined}>
      <button type="button" role="tab" aria-selected={selectedId === tab.id} aria-controls={`work-inspector-panel-${tab.id}`} onClick={() => onSelect(tab.id)}><InspectorToolIcon kind={tab.kind}/><span>{tab.label}</span></button>
      {selectedId === tab.id ? <button type="button" aria-label={`Close ${tab.label} tab`} title={`Close ${tab.label}`} disabled={tab.closing} onClick={() => onClose(tab.id)}><X size={14} aria-hidden/></button> : null}
    </div>)}
  </div>{tabs.find(tab => tab.id === selectedId)?.kind !== "new" ? addControl ?? <Button variant="ghost" size="icon" className="desktop-chat-icon" aria-label="Add inspector tab" onClick={onAdd}><Plus size={16} aria-hidden/></Button> : null}{trailing}</header>;
}

export function ChatInspectorNewTab({ browser = false, sideChat = true, onChoose, recent = [] }: {
  browser?: boolean; sideChat?: boolean; onChoose(kind: Exclude<InspectorTool, "new">): void;
  recent?: readonly { id: string; kind: Exclude<InspectorTool, "new">; title: string; subtitle?: string; onOpen(): void }[];
}) {
  const choices = [{ kind: "files" as const, label: "Files", shortcut: "⌘P" }, { kind: "terminal" as const, label: "Terminal", shortcut: "⌃`" },
    ...(sideChat ? [{ kind: "side-chat" as const, label: "Side chat", shortcut: "⌥⌘S" }] : []), ...(browser ? [{ kind: "browser" as const, label: "Browser", shortcut: "⌘T" }] : [])];
  return <div className="desktop-chat-design chat-inspector-picker" role="tabpanel" aria-label="New tab" id="work-inspector-panel-new-tab"><h2>Open</h2>
    {choices.map(choice => <button type="button" key={choice.kind} onClick={() => onChoose(choice.kind)}><InspectorToolIcon kind={choice.kind}/><span>{choice.label}</span><kbd>{choice.shortcut}</kbd></button>)}
    {recent.length ? <><h2>Recent</h2>{recent.map(item => <button type="button" key={item.id} onClick={item.onOpen}><InspectorToolIcon kind={item.kind}/><span>{item.title}{item.subtitle ? <small>{item.subtitle}</small> : null}</span></button>)}</> : null}
  </div>;
}

export function ChatInspectorResizeHandle({ side, label, value, min, max, onPointerDown, onKeyboardResize, onReset }: {
  side: "left" | "right"; label: string; value: number; min: number; max: number;
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void; onKeyboardResize(delta: number): void; onReset(): void;
}) {
  const [dragging, setDragging] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0}
    className={`desktop-chat-design chat-inspector-resize chat-inspector-resize-${side}`} data-resizing={dragging || undefined}
    onPointerDown={event => {
      cleanup.current?.(); setDragging(true); onPointerDown(event);
      const end = () => { setDragging(false); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
      window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true });
      cleanup.current = () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
    }} onDoubleClick={onReset} onKeyDown={event => {
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!direction) return;
      event.preventDefault(); onKeyboardResize(side === "left" ? -direction * 16 : direction * 16);
    }}><span className="chat-inspector-resize-line" style={{ background: side === "left" ? "transparent" : "var(--chat-line)" }}/><span className="chat-inspector-resize-grip"/><span className="chat-inspector-resize-width" aria-hidden>{Math.round(value)} px</span></div>;
}
