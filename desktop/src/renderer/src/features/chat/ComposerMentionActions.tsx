import { Monitor, SquareTerminal } from "@renderer/lib/hugeicons";

export interface ComposerMentionAction {
  label: string;
  kind: "preview" | "terminal";
  keywords: string;
  consumeTrigger?: true;
  slashCommand?: string;
  select: (queryDraft: string, remainingDraft?: string) => void;
}

export function ComposerMentionActions({ actions, selectedIndex, onSelect }: {
  actions: readonly ComposerMentionAction[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  if (!actions.length) return null;
  return (
    <>
      <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
        This Mac
      </p>
      {actions.map(({ label, kind }, index) => {
        const Icon = kind === "preview" ? Monitor : SquareTerminal;
        return (
          <button
            key={label}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-primary)" }}
            onClick={() => onSelect(index)}
          >
            <Icon className="shrink-0" size={15} aria-hidden style={{ color: "var(--text-tertiary)" }} />
            <span>{label}</span>
          </button>
        );
      })}
    </>
  );
}
