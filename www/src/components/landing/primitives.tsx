import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { palette as c, cardShadow, fonts } from "./theme";

type CtaVariant = "dark" | "outline";

type CtaButtonProps = {
  href: string;
  children: ReactNode;
  variant?: CtaVariant;
  external?: boolean;
  large?: boolean;
  phLocation?: string;
  phTarget?: string;
};

const ctaBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  borderRadius: "0.625rem",
  lineHeight: 1,
  fontFamily: fonts.sans,
  transition: "background 0.3s ease, border-color 0.3s ease, opacity 0.3s ease",
};

const ctaVariants: Record<CtaVariant, CSSProperties> = {
  dark: { backgroundColor: c.deep, border: `1px solid ${c.deep}`, color: "#FAFAF5" },
  outline: { backgroundColor: "rgba(252,252,248,0.7)", border: `1px solid ${c.border}`, color: c.deep },
};

export function CtaButton({ href, children, variant = "dark", external = false, large = false, phLocation, phTarget }: CtaButtonProps) {
  const style: CSSProperties = {
    ...ctaBase,
    ...ctaVariants[variant],
    padding: large ? "1rem 1.5rem" : "0.75rem 1.125rem",
    fontSize: large ? "1.0625rem" : "0.9375rem",
  };
  const telemetry = phTarget
    ? { "data-ph-event": "marketing_cta_clicked", "data-ph-location": phLocation, "data-ph-target": phTarget }
    : {};
  const className = "transition-opacity hover:opacity-85";

  if (external || href.startsWith("http")) {
    return (
      <a href={href} style={style} className={className} {...telemetry} {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} style={style} className={className} {...telemetry}>
      {children}
    </Link>
  );
}

export function SectionTitle({ title, continuation, light = false }: { title: string; continuation?: string; light?: boolean }) {
  return (
    <h2
      className="text-[1.5rem] leading-[1.3] font-medium tracking-[-0.01em] md:text-[2rem]"
      style={{ fontFamily: fonts.sans, color: light ? "#FAFAF5" : c.deep }}
    >
      {title}
      {continuation ? (
        <>
          {" "}
          <span style={{ color: light ? "rgba(250,250,245,0.55)" : c.subtle, fontWeight: 500 }}>{continuation}</span>
        </>
      ) : null}
    </h2>
  );
}

export function SectionCard({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div
      className={`rounded-2xl ${className}`}
      style={{ backgroundColor: c.card, boxShadow: cardShadow, ...style }}
    >
      {children}
    </div>
  );
}

export function SectionShell({ children, id, className = "" }: { children: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-[1400px] px-5 md:px-10 ${className}`}>
      {children}
    </section>
  );
}

export function PageHero({ eyebrow, title, sub, children }: { eyebrow?: string; title: ReactNode; sub?: string; children?: ReactNode }) {
  return (
    <SectionShell className="pt-10 md:pt-16">
      <div className="mx-auto flex max-w-[52rem] flex-col items-center text-center">
        {eyebrow ? (
          <p className="mb-5 text-[0.9375rem]" style={{ fontFamily: fonts.display, color: c.subtle }}>
            {eyebrow}
          </p>
        ) : null}
        <h1
          className="text-[2.5rem] leading-[1.08] tracking-[-0.01em] md:text-[3.5rem]"
          style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
        >
          {title}
        </h1>
        {sub ? (
          <p className="mt-5 max-w-[34rem] text-[1rem] leading-[1.6] md:text-[1.0625rem]" style={{ color: c.subtle, fontFamily: fonts.sans }}>
            {sub}
          </p>
        ) : null}
        {children ? <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">{children}</div> : null}
      </div>
    </SectionShell>
  );
}
