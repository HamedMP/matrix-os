/** Tooltip text: "Bold (Ctrl+B)". */
export function tooltipFor(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

export function Chevron() {
  return (
    <svg className="oui-ribbon__chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
