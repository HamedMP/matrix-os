"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { POPOVER_LAYER } from "../layering.js";
import { focusRing, menuSurfaceStyle, tone } from "./board-style.js";

export interface BoardPickerOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Extra text matched by the search box, for example a task key. */
  keywords?: string;
}

interface BaseProps {
  /** Names the menu and, when `trigger` is omitted, the button. */
  label: string;
  options: readonly BoardPickerOption[];
  /** Custom trigger content; defaults to the label plus a count. */
  trigger?: ReactNode;
  triggerClassName?: string;
  /** Show a search box; on by default past eight options. */
  searchable?: boolean;
  /** Offer "Create …" for a search with no exact match (labels). */
  onCreate?: (value: string) => void;
  emptyText?: string;
  align?: "start" | "end";
  disabled?: boolean;
  /** Render in place instead of portalling to <body>; needed inside a modal <dialog>, which sits in the top layer. */
  portal?: boolean;
}

export type BoardPickerProps =
  | (BaseProps & { multiple: true; value: readonly string[]; onChange: (value: string[]) => void })
  | (BaseProps & { multiple?: false; value: string; onChange: (value: string) => void });

const MAX_CREATE_LENGTH = 40;

/** Compact popover picker for board filters and task fields; single or multiple choice, keyboard friendly. */
export function BoardPicker(props: BoardPickerProps) {
  const { label, options, trigger, triggerClassName, onCreate, emptyText = "Nothing to choose from", align = "start", disabled, portal = true } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listId = useId();
  const searchable = props.searchable ?? (options.length > 8 || Boolean(onCreate));
  const selected = props.multiple ? props.value : [props.value];
  const query = search.trim().toLowerCase();
  const shown = useMemo(() => (query
    ? options.filter((option) => `${option.label} ${option.keywords ?? ""}`.toLowerCase().includes(query))
    : options), [options, query]);
  const canCreate = Boolean(onCreate) && query.length > 0 && query.length <= MAX_CREATE_LENGTH
    && !options.some((option) => option.label.toLowerCase() === query);

  const choose = (value: string) => {
    if (props.multiple) {
      props.onChange(props.value.includes(value) ? props.value.filter((item) => item !== value) : [...props.value, value]);
      return;
    }
    props.onChange(value);
    setOpen(false);
  };

  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
    <Popover.Trigger asChild disabled={disabled}>
      <button type="button" aria-label={trigger ? label : undefined} aria-haspopup="listbox"
        className={triggerClassName ?? `flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] hover:bg-[var(--bg-hover)] aria-expanded:bg-[var(--bg-hover)] disabled:opacity-50 ${focusRing}`}
        style={tone.primary}>
        {trigger ?? <>
          <span>{label}</span>
          {props.multiple && props.value.length > 0 ? <span className="rounded-full px-1.5 text-[11px] font-semibold" style={{ background: "var(--bg-sunken, var(--muted))" }}>{props.value.length}</span> : null}
          <ChevronDown size={12} aria-hidden style={tone.muted} />
        </>}
      </button>
    </Popover.Trigger>
    <MaybePortal portal={portal}>
      <Popover.Content align={align} side="bottom" sideOffset={6} collisionPadding={12}
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-60 flex-col overflow-hidden rounded-xl border p-1.5 shadow-lg"
        style={{ ...menuSurfaceStyle, zIndex: POPOVER_LAYER }}
        onOpenAutoFocus={(event) => { if (!searchable) return; event.preventDefault(); (event.currentTarget as HTMLElement).querySelector("input")?.focus(); }}>
        <span className="block px-2 pb-1 pt-0.5 text-[11px] font-medium" style={tone.muted}>{label}</span>
        {searchable ? <input type="text" aria-label={`Search ${label.toLowerCase()}`} aria-controls={listId} value={search} maxLength={MAX_CREATE_LENGTH}
          placeholder={onCreate ? "Search or create…" : "Search…"} onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (shown[0]) choose(shown[0].value);
            else if (canCreate && onCreate) { onCreate(search.trim()); setSearch(""); }
          }}
          className="mb-1 h-8 rounded-lg border bg-transparent px-2 text-[13px] outline-none focus:border-[var(--text-primary,var(--foreground))]"
          style={tone.border} /> : null}
        <div id={listId} role="listbox" aria-label={label} aria-multiselectable={props.multiple || undefined} className="min-h-0 overflow-y-auto">
          {shown.map((option) => {
            const isSelected = selected.includes(option.value);
            return <button key={option.value} type="button" role="option" aria-selected={isSelected} onClick={() => choose(option.value)}
              className={`flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-[var(--bg-hover)] ${focusRing}`}>
              {option.icon ? <span className="grid w-4 shrink-0 place-items-center">{option.icon}</span> : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <Check size={13} aria-hidden className={isSelected ? "opacity-100" : "opacity-0"} />
            </button>;
          })}
          {canCreate && onCreate ? <button type="button" onClick={() => { onCreate(search.trim()); setSearch(""); }}
            className={`flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-[var(--bg-hover)] ${focusRing}`}>
            <Plus size={13} aria-hidden /> Create “{search.trim()}”
          </button> : null}
          {shown.length === 0 && !canCreate ? <p className="px-2 py-2 text-[12px]" style={tone.muted}>{query ? "No matches" : emptyText}</p> : null}
        </div>
      </Popover.Content>
    </MaybePortal>
  </Popover.Root>;
}

function MaybePortal({ portal, children }: { portal: boolean; children: ReactNode }) {
  return portal ? <Popover.Portal>{children}</Popover.Portal> : <>{children}</>;
}
