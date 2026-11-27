// Design-library menu look (components/ui/menu-styles.ts), mapped to ds- tokens.
// One card, one row, one label, one divider for dropdowns, context menus and submenus.

// Stacking comes from DESKTOP_Z_INDEX.popover, applied as a style by Menu.tsx.
export const menuSurface =
  "ds-menu-surface min-w-45 overflow-x-hidden overflow-y-auto rounded-lg border border-ds-border bg-ds-popover p-1 font-ds-sans text-ds-foreground shadow-ds-lg fade-in";

/** Highlight follows hover and keyboard; inner radius 12 − 4 padding = 8. */
export const menuItem = [
  "relative flex h-8 w-full cursor-default items-center gap-1.5 rounded-md px-2 text-ds-ui text-ds-foreground outline-none select-none",
  "data-[highlighted]:bg-ds-accent",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ds-muted-foreground",
].join(" ");

export const menuItemDestructive = "text-ds-destructive-text [&_svg]:text-ds-destructive-text data-[highlighted]:bg-ds-tint-destructive-fill";

/** Rows with a selected state show a check at the end. */
export const menuItemWithCheck = "pr-7";
export const menuCheck = "pointer-events-none absolute right-2 flex size-3.5 items-center justify-center [&_svg]:text-ds-foreground";

export const menuLabel = "px-2 pt-2 pb-1 text-ds-ui-xs font-medium text-ds-muted-foreground";

/** Full-bleed divider: only between labelled groups and before the destructive row. */
export const menuSeparator = "pointer-events-none -mx-1 my-1 h-px bg-ds-tint-neutral-border";

export const menuShortcut = "ml-auto pl-4 text-ds-ui-sm text-ds-muted-foreground tracking-wide";
