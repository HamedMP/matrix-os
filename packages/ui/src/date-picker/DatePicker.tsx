"use client";

import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DayPicker, type DayPickerProps } from "react-day-picker";
import { POPOVER_LAYER } from "../layering.js";
import { fromDateKey, toDateKey } from "./date-key.js";

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent))]";

/** shadcn-style month calendar on react-day-picker, themed with the shell's semantic tokens. */
export function Calendar(props: DayPickerProps) {
  return <DayPicker showOutsideDays {...props}
    classNames={{
      root: "relative p-1 text-[13px] text-[var(--text-primary,var(--foreground))]",
      months: "flex flex-col",
      month: "flex flex-col gap-2",
      month_caption: "flex h-8 items-center px-2",
      caption_label: "text-[13px] font-semibold",
      nav: "absolute right-1 top-1 flex items-center gap-0.5",
      button_previous: `grid size-8 place-items-center rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-40 ${focusRing}`,
      button_next: `grid size-8 place-items-center rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-40 ${focusRing}`,
      month_grid: "border-collapse",
      weekdays: "flex",
      weekday: "w-8 pb-1 text-center text-[11px] font-medium text-[var(--text-tertiary,var(--muted-foreground))]",
      week: "flex",
      day: "size-8 p-0 text-center",
      day_button: `size-8 rounded-lg text-[13px] hover:bg-[var(--bg-hover)] ${focusRing}`,
      selected: "[&>button]:bg-[var(--primary)] [&>button]:font-medium [&>button]:text-[var(--primary-foreground)] [&>button]:hover:bg-[var(--primary)]",
      today: "[&>button]:font-semibold [&>button]:underline [&>button]:underline-offset-4",
      outside: "[&>button]:text-[var(--text-tertiary,var(--muted-foreground))] [&>button]:opacity-60",
      disabled: "[&>button]:opacity-40",
      hidden: "invisible",
      ...props.classNames,
    }}
    components={{
      Chevron: ({ orientation }) => (orientation === "left" ? <ChevronLeft size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />),
      ...props.components,
    }} />;
}

export interface DatePickerProps {
  /** YYYY-MM-DD, or null for no date. */
  value: string | null;
  onChange(value: string | null): void;
  label: string;
  placeholder?: string;
  triggerClassName?: string;
  /** Extra content next to the date in the trigger, for example an overdue hint. */
  adornment?: ReactNode;
  /** Render in place instead of portalling to <body> (inside a modal <dialog>). */
  portal?: boolean;
}

/** Button that opens a Calendar in a popover; Clear removes the date. */
export function DatePicker({ value, onChange, label, placeholder = "No date", triggerClassName, adornment, portal = true }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = fromDateKey(value);
  const shown = selected?.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const content = <Popover.Content align="start" sideOffset={6} collisionPadding={12}
    className="rounded-xl border p-2 shadow-lg"
    style={{ zIndex: POPOVER_LAYER, borderColor: "var(--border-default, var(--border))", background: "var(--bg-overlay, var(--popover, var(--card)))" }}>
    <Calendar mode="single" selected={selected} defaultMonth={selected} autoFocus
      onSelect={(date) => { onChange(date ? toDateKey(date) : null); setOpen(false); }} />
    {selected ? <div className="flex justify-end border-t pt-2" style={{ borderColor: "var(--border-subtle, var(--border))" }}>
      <button type="button" onClick={() => { onChange(null); setOpen(false); }}
        className={`flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px] text-[var(--text-secondary,var(--muted-foreground))] hover:bg-[var(--bg-hover)] ${focusRing}`}>
        <X size={12} aria-hidden />Clear date
      </button>
    </div> : null}
  </Popover.Content>;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" aria-label={`${label}: ${shown ?? placeholder}`}
        className={triggerClassName ?? `flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-[var(--bg-hover)] aria-expanded:bg-[var(--bg-hover)] ${focusRing}`}>
        <CalendarDays size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary,var(--muted-foreground))]" />
        <span className={selected ? "truncate" : "truncate text-[var(--text-tertiary,var(--muted-foreground))]"}>{shown ?? placeholder}</span>
        {adornment}
      </button>
    </Popover.Trigger>
    {portal ? <Popover.Portal>{content}</Popover.Portal> : content}
  </Popover.Root>;
}
