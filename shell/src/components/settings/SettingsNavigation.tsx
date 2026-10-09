import type { ComponentType } from "react";
import { CheckCircle2Icon } from "@/lib/hugeicons";
export function SettingsNavigation({
  sections,
  activeSection,
  onSelect,
  mobile,
  onboarding,
  lockedSection,
}: {
  sections: readonly {
    id: string;
    label: string;
    icon: ComponentType<{ className?: string }>;
  }[];
  activeSection: string;
  onSelect: (id: string) => void;
  mobile: boolean;
  onboarding: boolean;
  lockedSection?: string;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className={
        mobile
          ? "flex flex-col gap-3 p-4"
          : "flex flex-wrap gap-1 overflow-x-auto pb-1 sm:min-h-0 sm:flex-1 sm:flex-col sm:flex-nowrap sm:gap-0.5 sm:overflow-x-visible sm:overflow-y-auto sm:pb-0"
      }
    >
      {sections.map((section) => {
        const Icon = section.icon;
        const active = activeSection === section.id;
        const completed = onboarding && section.id === "billing";
        const unavailable = onboarding && section.id !== "default-installs";
        const locked =
          unavailable || Boolean(lockedSection && section.id !== lockedSection);
        const label = completed
          ? `${section.label} Completed`
          : unavailable
            ? `${section.label} Unavailable until your VPS is ready`
            : locked
              ? `${section.label} Locked until billing is active`
              : section.label;
        return (
          <button
            key={section.id}
            type="button"
            disabled={locked}
            aria-label={label}
            aria-current={!mobile && active ? "page" : undefined}
            onClick={() => {
              if (!locked) onSelect(section.id);
            }}
            className={mobile
              ? `min-h-16 border border-border bg-card px-4 py-4 text-base flex w-full items-center gap-3 rounded-xl text-left transition-colors ${locked ? "text-muted-foreground/45" : "text-foreground hover:bg-foreground/5"}`
              : `flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2.5 text-[13px] transition-colors sm:order-none sm:px-2.5 sm:py-1.5 ${active ? "order-first bg-sidebar-accent text-sidebar-accent-foreground font-semibold" : locked ? "cursor-not-allowed text-muted-foreground/45" : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"}`}
          >
            <Icon className={mobile ? "size-5 shrink-0" : `size-4 shrink-0 ${active ? "text-sidebar-accent-foreground" : ""}`} />
            <span>{section.label}</span>
            {completed ? (
              mobile ? <CheckCircle2Icon className="ml-auto size-4 text-forest/65" /> : <CheckCircle2Icon className="ml-auto size-3.5 text-forest/65" aria-hidden="true" />
            ) : mobile ? (
              <span className="ml-auto text-muted-foreground" aria-hidden>
                ›
              </span>
            ) : null}
            {!mobile && locked && !onboarding ? <span className="sr-only">Locked until billing is active</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
