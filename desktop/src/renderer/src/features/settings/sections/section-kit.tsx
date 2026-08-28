import type { ReactNode } from "react";

export function SettingsSectionHeader({
  title,
  description,
  className = "",
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div data-testid="settings-section-header" className={`mb-6 flex flex-col gap-1 ${className}`}>
      <h3 data-testid="settings-section-header-title" className="text-lg font-normal tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>
        {title}
      </h3>
      {description ? (
        <p data-testid="settings-section-header-description" className="text-sm font-normal" style={{ color: "var(--text-secondary)" }}>{description}</p>
      ) : null}
    </div>
  );
}

// Compatibility export for inactive/legacy settings sections.
export const SectionHeader = SettingsSectionHeader;

export function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-4 flex flex-col gap-3 rounded-xl border p-4"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      {children}
    </div>
  );
}

export function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col">
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{label}</span>
        {hint ? <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{hint}</span> : null}
      </div>
      <span className="text-right text-sm" style={{ color: "var(--text-primary)" }} data-selectable>{value}</span>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>{text}</p>;
}
