/**
 * Sheet tabs: switch, add, rename (double click or the menu), delete after
 * confirmation, reorder (drag, or Move left / Move right) and colour.
 */
import { MoreHorizontal, Plus } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { Dialog, Dropdown, type DropdownItem } from "../../../_shared/office-ui";
import type { SheetId, SheetInfo } from "../session/engine";
import type { SheetSession } from "../session/session";
import { TAB_COLORS, TAB_COLOR_LABELS, type TabLook, isTabColor, moveTab, orderedSheets, setTabColor } from "./sheet-tabs-model";

export interface SheetTabsProps {
  session: SheetSession;
  activeSheetId: SheetId;
  /** Content revision, so names and the sheet list follow edits. */
  revision: number;
  look: TabLook;
  onLookChange: (look: TabLook) => void;
  onFailure: (message: string) => void;
  readOnly?: boolean;
}

function menuItems(index: number, count: number, look: TabLook, id: SheetId): DropdownItem[] {
  return [
    { id: "rename", label: "Rename" },
    ...TAB_COLORS.map((color, i) => ({ id: `color:${color}`, label: `Colour: ${TAB_COLOR_LABELS[color]}`, checked: look.colors[id] === color, separatorBefore: i === 0 })),
    { id: "color:none", label: "No colour", checked: look.colors[id] === undefined },
    { id: "left", label: "Move left", disabled: index === 0, separatorBefore: true },
    { id: "right", label: "Move right", disabled: index === count - 1 },
    { id: "delete", label: "Delete", danger: true, disabled: count <= 1, separatorBefore: true },
  ];
}

export function SheetTabs({ session, activeSheetId, revision, look, onLookChange, onFailure, readOnly = false }: SheetTabsProps) {
  const [renaming, setRenaming] = useState<{ id: SheetId; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SheetInfo | null>(null);
  const dragging = useRef<SheetId | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  // Read every render: `revision` changes with each edit, renames and added sheets included.
  const sheets = revision >= 0 ? session.sheets() : [];
  const tabs = orderedSheets(sheets, look);
  const activeIndex = tabs.findIndex((sheet) => sheet.id === activeSheetId);
  const activeTab = tabs[activeIndex];

  const commitRename = (): void => {
    if (renaming === null) return;
    const text = renaming.text.trim();
    const current = sheets.find((sheet) => sheet.id === renaming.id);
    setRenaming(null);
    if (current === undefined || text === "" || text === current.name) return;
    const result = session.renameSheet(renaming.id, text);
    if (!result.ok) onFailure(result.message);
  };

  const onMenu = (sheet: SheetInfo, index: number, action: string): void => {
    if (action === "rename") setRenaming({ id: sheet.id, text: sheet.name });
    else if (action === "left") onLookChange(moveTab(look, sheets, sheet.id, index - 1));
    else if (action === "right") onLookChange(moveTab(look, sheets, sheet.id, index + 1));
    else if (action === "delete") setConfirmDelete(sheet);
    else if (action.startsWith("color:")) {
      const color = action.slice(6);
      onLookChange(setTabColor(look, sheet.id, isTabColor(color) ? color : null));
    }
  };

  const add = (): void => {
    const result = session.addSheet();
    if (!result.ok) onFailure(result.message);
  };

  const remove = (): void => {
    const sheet = confirmDelete;
    setConfirmDelete(null);
    if (sheet === null) return;
    const result = session.removeSheet(sheet.id);
    if (!result.ok) onFailure(result.message);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target: SheetInfo | undefined;
    if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "F2" && !readOnly) {
      event.preventDefault();
      const sheet = tabs[index];
      if (sheet !== undefined) setRenaming({ id: sheet.id, text: sheet.name });
      return;
    } else return;
    event.preventDefault();
    if (target === undefined) return;
    session.setActiveSheet(target.id);
    document.getElementById(`sheet-tab-${target.id}`)?.focus();
  };

  return (
    <div className="sheets-tabs">
      <div role="tablist" aria-label="Sheets" className="sheets-tabs__list">
        {tabs.map((sheet, index) => {
          const selected = sheet.id === activeSheetId;
          const color = look.colors[sheet.id];
          if (renaming?.id === sheet.id) {
            return (
              <input
                key={sheet.id}
                className="sheets-tabs__rename"
                aria-label={`New name for ${sheet.name}`}
                value={renaming.text}
                maxLength={31}
                autoFocus
                onChange={(event) => setRenaming({ id: sheet.id, text: event.currentTarget.value })}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenaming(null);
                  }
                }}
              />
            );
          }
          return (
            <div
              key={sheet.id}
              className={`sheets-tabs__tab${selected ? " is-selected" : ""}${color ? ` sheets-tab-color--${color}` : ""}`}
              onDragOver={(event) => {
                if (dragging.current !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragging.current;
                dragging.current = null;
                if (id !== null && id !== sheet.id) onLookChange(moveTab(look, sheets, id, index));
              }}
            >
              <button
                id={`sheet-tab-${sheet.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="sheets-tabs__button"
                draggable={!readOnly}
                onDragStart={(event) => {
                  dragging.current = sheet.id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", sheet.name);
                }}
                onDragEnd={() => {
                  dragging.current = null;
                }}
                onClick={() => session.setActiveSheet(sheet.id)}
                onDoubleClick={() => {
                  if (!readOnly) setRenaming({ id: sheet.id, text: sheet.name });
                }}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                {sheet.name}
                {sheet.pendingChangeCount > 0 && <span className="sheets-tabs__pending" aria-label={`${sheet.pendingChangeCount} proposed changes`} />}
              </button>
            </div>
          );
        })}
      </div>
      {activeTab !== undefined && !readOnly && (
        <Dropdown
          className="sheets-tabs__menu"
          label={<MoreHorizontal size={14} aria-hidden="true" />}
          ariaLabel={`Options for ${activeTab.name}`}
          items={menuItems(activeIndex, tabs.length, look, activeTab.id)}
          onSelect={(action) => onMenu(activeTab, activeIndex, action)}
        />
      )}
      {!readOnly && (
        <button type="button" className="sheets-icon-btn sheets-tabs__add" aria-label="Add sheet" onClick={add}>
          <Plus size={16} />
        </button>
      )}
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        role="alertdialog"
        size="sm"
        title={`Delete ${confirmDelete?.name ?? "sheet"}?`}
        description="The sheet and everything on it is removed. This cannot be undone. Formulas that use it will show #REF!."
        initialFocusRef={cancelButton}
        footer={
          <>
            <button ref={cancelButton} type="button" className="oui-button oui-button--ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button type="button" className="oui-button oui-button--danger" onClick={remove}>
              Delete sheet
            </button>
          </>
        }
      />
    </div>
  );
}
