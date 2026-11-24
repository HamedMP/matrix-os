import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { dsCn as cn } from "./cn";

/** Moves focus between sibling items with arrow keys, Home and End. Returns the new index. */
export function rovingIndex(key: string, index: number, count: number, orientation: "horizontal" | "vertical" = "horizontal"): number | null {
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  if (count === 0) return null;
  if (key === next) return (index + 1) % count;
  if (key === prev) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * Design-library Tabs/List "default" (segmented) used for exclusive choices
 * such as Grid/List or a search scope. Exposed as a radio group because
 * choosing a segment changes a setting rather than revealing a tab panel.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  iconOnly = false,
  className,
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  iconOnly?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = rovingIndex(event.key, index, options.length);
    if (next === null) return;
    event.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex h-8 items-center gap-0.5 rounded-md bg-ds-card p-0.5", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "ds-focus no-drag inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] font-ds-sans text-ds-ui-sm font-medium transition-colors duration-[120ms] [&_svg]:size-4",
              iconOnly ? "w-7" : "px-2.5",
              checked ? "bg-ds-background text-ds-foreground shadow-ds-sm" : "text-ds-muted-foreground hover:text-ds-foreground",
            )}
          >
            {option.icon}
            {iconOnly ? null : option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
}

/**
 * Design-library Tabs. `line` is the 2px underline list used inside panels; each
 * tab controls the panel with id `${idPrefix}-panel-${id}`.
 */
export function LineTabs({
  label,
  tabs,
  value,
  onChange,
  idPrefix,
}: {
  label: string;
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={label} className="flex h-9 items-end gap-4 border-b border-ds-border">
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => { refs.current[index] = el; }}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next = rovingIndex(event.key, index, tabs.length);
              if (next === null) return;
              event.preventDefault();
              onChange(tabs[next]!.id);
              refs.current[next]?.focus();
            }}
            className={cn(
              "ds-focus-inset -mb-px h-9 border-b-2 font-ds-sans text-ds-ui font-medium transition-colors duration-[120ms]",
              selected ? "border-ds-primary text-ds-foreground" : "border-transparent text-ds-muted-foreground hover:text-ds-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, id, active, children, className }: { idPrefix: string; id: string; active: boolean; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} hidden={!active} className={className}>
      {active ? children : null}
    </div>
  );
}

/** Classes for the "default" pill tab trigger (folder tabs); the active pill gets a surface, border and shadow. */
export function pillTabClass(active: boolean): string {
  return cn(
    "ds-focus no-drag flex h-8 min-w-0 items-center gap-1.5 rounded-md border font-ds-sans text-ds-ui-sm font-medium transition-colors duration-[120ms]",
    active ? "border-ds-border bg-ds-background text-ds-foreground shadow-ds-sm" : "border-transparent text-ds-muted-foreground hover:bg-ds-accent hover:text-ds-foreground",
  );
}
