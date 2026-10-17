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
          : "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
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
            className={`${mobile ? "min-h-16 border border-border bg-card px-4 py-4 text-base" : "px-2.5 py-2 text-[13px]"} flex w-full items-center gap-3 rounded-xl text-left transition-colors ${locked ? "text-muted-foreground/45" : !mobile && active ? "bg-ember/12 font-semibold text-deep" : "text-foreground hover:bg-foreground/5"}`}
          >
            <Icon className="size-5 shrink-0" />
            <span>{section.label}</span>
            {completed ? (
              <CheckCircle2Icon className="ml-auto size-4 text-forest/65" />
            ) : mobile ? (
              <span className="ml-auto text-muted-foreground" aria-hidden>
                ›
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
