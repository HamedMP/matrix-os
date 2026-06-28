import type { CSSProperties, ReactNode } from "react";
import { palette as c, cardShadow, fonts, radii } from "./tokens.js";

type CtaVariant = "dark" | "outline" | "text";

const ctaBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  borderRadius: radii.control,
  lineHeight: 1,
  fontFamily: fonts.sans,
  fontWeight: 500,
  textDecoration: "none",
  transition: "background 0.3s ease, border-color 0.3s ease, opacity 0.3s ease",
};

const ctaVariants: Record<CtaVariant, CSSProperties> = {
  dark: { backgroundColor: c.deep, border: `1px solid ${c.deep}`, color: "#FAFAF5", padding: "0.75rem 1.125rem" },
  outline: { backgroundColor: "rgba(252,252,248,0.7)", border: `1px solid ${c.border}`, color: c.deep, padding: "0.75rem 1.125rem" },
  text: { background: "transparent", color: c.forest, padding: "0.75rem 0.375rem" },
};

export function CtaButton({
  href,
  children,
  variant = "dark",
  style,
}: {
  href: string;
  children: ReactNode;
  variant?: CtaVariant;
  style?: CSSProperties;
}) {
  return (
    <a href={href} style={{ ...ctaBase, ...ctaVariants[variant], ...style }}>
      {children}
    </a>
  );
}

export function BrandCard({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className} style={{ backgroundColor: c.card, border: `1px solid ${c.border}`, borderRadius: radii.card, boxShadow: cardShadow, ...style }}>
      {children}
    </div>
  );
}

export function SectionTitle({ title, continuation, light = false }: { title: string; continuation?: string; light?: boolean }) {
  return (
    <h2 style={{ fontFamily: fonts.sans, fontSize: "clamp(1.5rem,3vw,2rem)", fontWeight: 500, letterSpacing: "-0.01em", color: light ? "#FAFAF5" : c.deep, margin: 0 }}>
      {title}
      {continuation ? <span style={{ color: light ? "rgba(250,250,245,0.55)" : c.subtle }}> {continuation}</span> : null}
    </h2>
  );
}

const pillTones = {
  connected: { bg: "rgba(67,78,63,0.08)", color: "#3B6D11" },
  ready: { bg: "rgba(67,78,63,0.08)", color: "#3B6D11" },
  pending: { bg: "rgba(208,111,37,0.10)", color: "#993C1D" },
} as const;

export function StatusPill({ tone, children }: { tone: keyof typeof pillTones; children: ReactNode }) {
  const t = pillTones[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: t.bg, color: t.color, fontSize: "12px", fontWeight: 500, padding: "5px 11px", borderRadius: radii.pill }}>
      {children}
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: fonts.sans, fontSize: "11px", fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: c.subtle }}>
      {children}
    </span>
  );
}
