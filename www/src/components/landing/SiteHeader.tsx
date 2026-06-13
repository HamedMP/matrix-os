"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { Logo } from "./Logo";
import { palette as c, fonts } from "./theme";

type NavLinkConfig = { label: string; href: string };

const navLinks: NavLinkConfig[] = [
  { label: "Symphony", href: "/symphony" },
  { label: "Hermes", href: "/hermes" },
  { label: "Use cases", href: "/use-cases" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Docs", href: "/docs" },
];

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("scroll", close, { passive: true });
    return () => window.removeEventListener("scroll", close);
  }, [menuOpen]);

  return (
    <header className="site-header" style={{ fontFamily: fonts.sans }}>
      <style>{`
        .site-header {
          position: sticky;
          top: 0;
          z-index: 100;
          animation: header-enter 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes header-enter {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .site-header { animation: none; }
        }
        .site-header-inner {
          display: flex;
          align-items: center;
          gap: 1rem;
          max-width: 1400px;
          margin: 0 auto;
          padding: 0.875rem 1.25rem;
        }
        @media (min-width: 1024px) {
          .site-header-inner { padding: 1.25rem 2.5rem; }
        }
        .site-header-brand {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
          border-radius: 0.625rem;
          padding: 0.375rem 0.75rem 0.375rem 0.5rem;
          background: rgba(252, 252, 248, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .site-header-pill {
          display: none;
          align-items: center;
          gap: 0.125rem;
          border-radius: 0.625rem;
          padding: 0.25rem 0.5rem;
          background: rgba(252, 252, 248, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        @media (min-width: 880px) {
          .site-header-pill { display: inline-flex; }
        }
        .site-header-link {
          padding: 0.5rem 0.625rem;
          font-size: 0.9375rem;
          color: ${c.deep};
          border-radius: 0.5rem;
          transition: opacity 0.2s ease;
        }
        .site-header-link:hover { opacity: 0.55; }
        .site-header-actions {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          margin-left: auto;
        }
        .site-header-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 0.625rem;
          border: 1px solid transparent;
          padding: 0.5rem 0.75rem;
          font-size: 0.9375rem;
          line-height: 1;
          cursor: pointer;
          transition: background 0.3s ease, border 0.3s ease, transform 0.3s ease;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .site-header-button:active { transform: scale(0.98); }
        .site-header-button-soft {
          background: rgba(252, 252, 248, 0.85);
          border-color: rgba(220, 217, 204, 0.6);
          color: ${c.deep};
        }
        .site-header-button-soft:hover { background: rgba(252, 252, 248, 1); }
        .site-header-button-dark {
          background: ${c.deep};
          border-color: ${c.deep};
          color: ${c.cream};
        }
        .site-header-button-dark:hover { background: ${c.forest}; border-color: ${c.forest}; }
        .site-header-menu-toggle { display: inline-flex; }
        @media (min-width: 880px) {
          .site-header-menu-toggle { display: none; }
        }
        .site-header-sheet {
          position: absolute;
          left: 1.25rem;
          right: 1.25rem;
          top: calc(100% + 0.25rem);
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          border-radius: 1rem;
          border: 1px solid ${c.border};
          background: ${c.card};
          box-shadow: 0 24px 80px rgba(50, 53, 46, 0.18);
          padding: 0.75rem;
        }
        @media (min-width: 880px) {
          .site-header-sheet { display: none; }
        }
        .site-header-sheet-link {
          border-radius: 0.625rem;
          padding: 0.75rem 0.875rem;
          font-size: 1rem;
          color: ${c.deep};
          transition: background 0.2s ease;
        }
        .site-header-sheet-link:hover { background: rgba(67, 78, 63, 0.06); }
      `}</style>

      <div className="site-header-inner">
        <Link href="/" aria-label="Matrix OS home" className="site-header-brand">
          <Logo className="h-6 w-auto min-[1100px]:h-7" style={{ color: c.deep }} />
          <span
            className="whitespace-nowrap text-[13px] font-bold tracking-tight min-[1100px]:text-[15px]"
            style={{ color: c.deep, fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
          >
            Matrix OS
          </span>
        </Link>

        <nav className="site-header-pill" aria-label="Primary">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="site-header-link">
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="site-header-actions">
          <SignedOut>
            <a
              href="https://app.matrix-os.com"
              className="site-header-button site-header-button-soft hidden sm:inline-flex"
              data-ph-event="marketing_cta_clicked"
              data-ph-location="nav"
              data-ph-target="sign_in"
            >
              Sign in
            </a>
            <a
              href="https://app.matrix-os.com"
              className="site-header-button site-header-button-dark"
              data-ph-event="marketing_cta_clicked"
              data-ph-location="nav"
              data-ph-target="get_started"
            >
              Get started
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="https://app.matrix-os.com"
              target="_blank"
              rel="noopener noreferrer"
              className="site-header-button site-header-button-dark"
              data-ph-event="marketing_cta_clicked"
              data-ph-location="nav"
              data-ph-target="open_app"
            >
              Open Matrix OS
            </a>
          </SignedIn>
          <button
            type="button"
            className="site-header-button site-header-button-soft site-header-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="site-header-sheet"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>
      </div>

      {menuOpen ? (
        <nav id="site-header-sheet" className="site-header-sheet" aria-label="Mobile">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="site-header-sheet-link"
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
