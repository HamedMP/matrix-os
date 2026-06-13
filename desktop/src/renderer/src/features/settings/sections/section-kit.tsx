import type { ReactNode } from "react";

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
        {title}
      </h3>
      {description ? (
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{description}</p>
      ) : null}
    </div>
  );
}

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
