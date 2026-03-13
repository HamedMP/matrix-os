"use client";

import { useCallback, useRef, useState } from "react";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useCanvasLabels, type CanvasLabel } from "@/stores/canvas-labels";
import { Trash2, Palette } from "lucide-react";

const LABEL_COLORS = [
  "#ffffff",
  "#94a3b8",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
];

interface CanvasTextLabelProps {
  label: CanvasLabel;
}

export function CanvasTextLabel({ label }: CanvasTextLabelProps) {
  const zoom = useCanvasTransform((s) => s.zoom);
  const moveLabel = useCanvasLabels((s) => s.moveLabel);
  const updateLabel = useCanvasLabels((s) => s.updateLabel);
  const deleteLabel = useCanvasLabels((s) => s.deleteLabel);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(label.text);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: label.x,
        origY: label.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [label.x, label.y, editing],
  );

  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const { startX, startY, origX, origY } = dragRef.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      moveLabel(label.id, origX + dx, origY + dy);
    },
    [label.id, zoom, moveLabel],
  );

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, []);

  const commitEdit = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed) {
      updateLabel(label.id, { text: trimmed });
    }
    setEditing(false);
  }, [editText, label.id, updateLabel]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        commitEdit();
      } else if (e.key === "Escape") {
        setEditText(label.text);
        setEditing(false);
      }
    },
    [commitEdit, label.text],
  );

  const onSelectColor = useCallback(
    (color: string) => {
      updateLabel(label.id, { color });
      setShowColorPicker(false);
    },
    [label.id, updateLabel],
  );

  const inverseScale = 1 / zoom;

  return (
    <div
      className="absolute"
      style={{
        left: label.x,
        top: label.y,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          transform: `scale(${inverseScale})`,
          transformOrigin: "left top",
        }}
      >
        <div
          className="group/label flex items-center gap-2 cursor-grab active:cursor-grabbing select-none"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onDoubleClick={onDoubleClick}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={onKeyDown}
              className="bg-transparent border-b border-primary text-xl font-bold outline-none min-w-[60px]"
              style={{ color: label.color }}
              autoFocus
            />
          ) : (
            <span
              className="text-xl font-bold whitespace-nowrap"
              style={{ color: label.color }}
            >
              {label.text}
            </span>
          )}
          <div className="opacity-0 group-hover/label:opacity-100 transition-opacity flex items-center gap-0.5">
            <div className="relative">
              <button
                className="p-0.5 rounded hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowColorPicker(!showColorPicker);
                }}
                aria-label="Change color"
              >
                <Palette className="size-3.5 text-muted-foreground" />
              </button>
              {showColorPicker && (
                <div
                  className="absolute top-full left-0 mt-1 p-1.5 rounded-lg bg-card/95 backdrop-blur-sm border border-border shadow-lg flex gap-1 flex-wrap"
                  style={{ width: 130, zIndex: 100 }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {LABEL_COLORS.map((color) => (
                    <button
                      key={color}
                      className="size-5 rounded-full border transition-transform hover:scale-110"
                      style={{
                        backgroundColor: color,
                        borderColor: color === label.color ? "var(--primary)" : "transparent",
                        boxShadow: color === label.color ? "0 0 0 2px var(--primary)" : "none",
                      }}
                      onClick={() => onSelectColor(color)}
                      aria-label={`Color ${color}`}
                    />
                  ))}
                </div>
              )}
            </div>
            <button
              className="p-0.5 rounded hover:bg-muted transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                deleteLabel(label.id);
              }}
              aria-label="Delete label"
            >
              <Trash2 className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
