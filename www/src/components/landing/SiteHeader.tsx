"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { Logo } from "./Logo";
import { IsoArt } from "./IsoArt";
import { palette as c, fonts } from "./theme";

type MenuLink = { label: string; desc: string; href: string };

type FeaturedCard = {
  title: string;
  linkLabel: string;
  href: string;
  art: "iso" | "terminal";
};

type NavItem =
  | { label: string; href: string; menu?: undefined }
  | { label: string; href?: undefined; menu: { links: MenuLink[]; featured: FeaturedCard } };

const navItems: NavItem[] = [
  {
    label: "Platform",
    menu: {
      links: [
        { label: "Symphony", desc: "Background coding agents, orchestrated", href: "/symphony" },
        { label: "Hermes", desc: "The resident agent for everything else", href: "/hermes" },
        { label: "Every screen", desc: "Web, CLI, mobile, and desktop", href: "/#surfaces" },
        { label: "Whitepaper", desc: "How Matrix works under the hood", href: "/whitepaper" },
      ],
      featured: {
        title: "Agents that keep working after your laptop closes",
        linkLabel: "Explore Symphony",
        href: "/symphony",
        art: "iso",
      },
    },
  },
  {
    label: "Use cases",
    menu: {
      links: [
        { label: "All use cases", desc: "Where background agents go to work", href: "/use-cases" },
        { label: "Developers", desc: "Coding agents with a real computer", href: "/solutions/ai-coding-agents-cloud-workspace" },
        { label: "Enterprise", desc: "AI experiments off managed laptops", href: "/solutions/enterprise-ai-coding-lab" },
        { label: "Universities", desc: "Repeatable labs for AI-native courses", href: "/solutions/university-ai-development-lab" },
        { label: "Hermes hosting", desc: "An always-on home for your agent", href: "/solutions/hermes-ai-agent-hosting" },
      ],
      featured: {
        title: "What you can hand to your agents today",
        linkLabel: "See use cases",
        href: "/use-cases",
        art: "terminal",
      },
    },
  },
  { label: "Pricing", href: "/#pricing" },
  { label: "Docs", href: "/docs" },
];

type SheetEntry =
  | { type: "group"; key: string; label: string }
  | { type: "link"; key: string; label: string; href: string };

const sheetEntries: SheetEntry[] = navItems.flatMap((item): SheetEntry[] => {
  if (!item.menu) {
    return [{ type: "link", key: item.label, label: item.label, href: item.href }];
  }
  return [
    { type: "group", key: item.label, label: item.label },
    ...item.menu.links.map((link): SheetEntry => ({ type: "link", key: link.href, label: link.label, href: link.href })),
  ];
});

function FeaturedArt({ art }: { art: FeaturedCard["art"] }) {
  if (art === "iso") {
    return (
      <div className="flex justify-center rounded-lg py-3" style={{ backgroundColor: "rgba(67,78,63,0.05)" }}>
        <IsoArt seed={1} className="h-auto w-full max-w-[150px]" />
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-lg p-3.5 text-[10px] leading-relaxed" style={{ backgroundColor: c.deep, fontFamily: "var(--font-jetbrains), monospace" }}>
      <p style={{ color: "#F4F2E6" }}>$ matrix run -it -- claude</p>
      <p style={{ color: "rgba(244,242,230,0.55)" }}>fix bugs from Linear</p>
      <p className="flex items-center gap-1.5" style={{ color: "rgba(244,242,230,0.55)" }}>
        <span className="size-1.5 rounded-full" style={{ backgroundColor: c.ember }} />
        running in the background
      </p>
    </div>
  );
}

export function SiteHeader() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!sheetOpen && openMenu === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSheetOpen(false);
        setOpenMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen, openMenu]);

  useEffect(() => {
    if (!sheetOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [sheetOpen]);

  const activeMenu = navItems.find(
    (item): item is Extract<NavItem, { menu: object }> => item.menu !== undefined && item.label === openMenu,
  );

  return (
    <header className="site-header" style={{ fontFamily: fonts.sans }}>
      <style>{`
        .site-header {
          position: sticky;
          top: 0;
          z-index: 100;
        }
        @keyframes header-enter {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .site-header-inner {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          max-width: 1400px;
          margin: 0 auto;
          padding: 0.875rem 1.25rem;
          animation: header-enter 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @media (min-width: 1024px) {
          .site-header-inner { padding: 1.25rem 2.5rem; gap: 1rem; }
        }
        .site-header-brand {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
          min-width: 0;
          border-radius: 0.625rem;
          padding: 0.375rem 0.75rem 0.375rem 0.5rem;
          background: rgba(252, 252, 248, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .site-header-nav-wrap {
          position: relative;
          display: none;
        }
        @media (min-width: 880px) {
          .site-header-nav-wrap { display: block; }
        }
        .site-header-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.125rem;
          border-radius: 0.625rem;
          padding: 0.25rem 0.5rem;
          background: rgba(252, 252, 248, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .site-header-link {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.5rem 0.625rem;
          font-size: 0.9375rem;
          color: ${c.deep};
          border-radius: 0.5rem;
          border: none;
          background: none;
          cursor: pointer;
          font-family: inherit;
          transition: color 0.25s ease, opacity 0.2s ease;
          white-space: nowrap;
        }
        .site-header-pill[data-open="true"] .site-header-link { color: rgba(92, 90, 79, 0.55); }
        .site-header-pill[data-open="true"] .site-header-link[data-active="true"] { color: ${c.deep}; }
        .site-header-pill[data-open="false"] .site-header-link:hover { opacity: 0.55; }
        .site-header-chevron {
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .site-header-link[data-active="true"] .site-header-chevron { transform: rotate(180deg); }
        .site-header-panel-anchor {
          position: absolute;
          top: 100%;
          left: 0;
          padding-top: 0.5rem;
          width: min(620px, calc(100vw - 2.5rem));
        }
        .site-header-panel {
          display: grid;
          grid-template-columns: 1.1fr 0.9fr;
          gap: 1.5rem;
          border-radius: 1rem;
          background: rgba(252, 252, 248, 0.97);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 24px 80px rgba(50, 53, 46, 0.18), 0 2px 8px rgba(50, 53, 46, 0.06);
          padding: 1.25rem;
          transform-origin: top left;
          animation: menu-pop 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes menu-pop {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .site-header-panel-link {
          display: block;
          border-radius: 0.625rem;
          padding: 0.625rem 0.75rem;
          transition: background 0.2s ease;
          animation: panel-link-enter 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
          animation-delay: var(--link-delay, 0ms);
        }
        @keyframes panel-link-enter {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .site-header-panel-link:hover { background: rgba(67, 78, 63, 0.06); }
        .site-header-featured {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          border-radius: 0.75rem;
          background: #F4F3EA;
          padding: 1rem;
        }
        .site-header-actions {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          margin-left: auto;
          flex-shrink: 0;
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
          white-space: nowrap;
          cursor: pointer;
          font-family: inherit;
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
        .site-header-signin { display: none; }
        @media (min-width: 880px) {
          .site-header-signin { display: inline-flex; }
        }
        .site-header-menu-toggle { display: inline-flex; }
        @media (min-width: 880px) {
          .site-header-menu-toggle { display: none; }
        }
        .site-header-sheet {
          position: fixed;
          inset: 0;
          z-index: 200;
          display: flex;
          flex-direction: column;
          background: ${c.card};
          padding: 1.25rem;
          overflow-y: auto;
          animation: sheet-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes sheet-enter {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @media (min-width: 880px) {
          .site-header-sheet { display: none; }
        }
        .site-header-sheet-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
        }
        .site-header-sheet-nav {
          display: flex;
          flex-direction: column;
          margin-top: 2.25rem;
        }
        .site-header-sheet-group {
          margin: 1.25rem 0 0.25rem;
          font-size: 0.8125rem;
          font-weight: 500;
          color: ${c.subtle};
          animation: sheet-link-enter 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
          animation-delay: var(--link-delay, 0ms);
        }
        .site-header-sheet-link {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.875rem 0.25rem;
          font-size: 1.375rem;
          font-weight: 500;
          letter-spacing: -0.01em;
          color: ${c.deep};
          border-bottom: 1px solid rgba(67, 78, 63, 0.1);
          transition: opacity 0.2s ease;
          animation: sheet-link-enter 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
          animation-delay: var(--link-delay, 0ms);
        }
        @keyframes sheet-link-enter {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .site-header-sheet-link:hover { opacity: 0.6; }
        .site-header-sheet-actions {
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
          margin-top: auto;
          padding-top: 2.5rem;
        }
        .site-header-sheet-actions .site-header-button {
          width: 100%;
          padding: 1rem;
          font-size: 1.0625rem;
        }
        @media (prefers-reduced-motion: reduce) {
          .site-header-inner,
          .site-header-panel,
          .site-header-panel-link,
          .site-header-sheet,
          .site-header-sheet-group,
          .site-header-sheet-link,
          .site-header-chevron { animation: none; transition: none; }
        }
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

        <div className="site-header-nav-wrap" onMouseLeave={() => setOpenMenu(null)}>
          <nav className="site-header-pill" data-open={openMenu !== null} aria-label="Primary">
            {navItems.map((item) =>
              item.menu ? (
                <button
                  key={item.label}
                  type="button"
                  className="site-header-link"
                  data-active={openMenu === item.label}
                  aria-expanded={openMenu === item.label}
                  aria-haspopup="true"
                  onMouseEnter={() => setOpenMenu(item.label)}
                  onClick={() => setOpenMenu((open) => (open === item.label ? null : item.label))}
                >
                  {item.label}
                  <ChevronDownIcon className="site-header-chevron size-3.5" aria-hidden="true" />
                </button>
              ) : (
                <Link
                  key={item.label}
                  href={item.href}
                  className="site-header-link"
                  onMouseEnter={() => setOpenMenu(null)}
                >
                  {item.label}
                </Link>
              ),
            )}
          </nav>

          {activeMenu ? (
            <div className="site-header-panel-anchor">
              <div className="site-header-panel" key={activeMenu.label}>
                <div>
                  {activeMenu.menu.links.map((link, index) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="site-header-panel-link"
                      style={{ "--link-delay": `${index * 35}ms` } as React.CSSProperties}
                      onClick={() => setOpenMenu(null)}
                    >
                      <span className="block text-[0.9375rem] font-medium" style={{ color: c.deep }}>
                        {link.label}
                      </span>
                      <span className="mt-0.5 block text-[0.8125rem]" style={{ color: c.subtle }}>
                        {link.desc}
                      </span>
                    </Link>
                  ))}
                </div>
                <div className="site-header-featured">
                  <FeaturedArt art={activeMenu.menu.featured.art} />
                  <p className="text-[0.9375rem] font-medium leading-[1.4]" style={{ color: c.deep }}>
                    {activeMenu.menu.featured.title}
                  </p>
                  <Link
                    href={activeMenu.menu.featured.href}
                    className="group mt-auto inline-flex items-center gap-1.5 text-[0.875rem] font-medium transition-opacity hover:opacity-70"
                    style={{ color: c.forest }}
                    onClick={() => setOpenMenu(null)}
                  >
                    {activeMenu.menu.featured.linkLabel}
                    <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="site-header-actions">
          <SignedOut>
            <a
              href="https://app.matrix-os.com"
              className="site-header-button site-header-button-soft site-header-signin"
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
            aria-expanded={sheetOpen}
            aria-controls="site-header-sheet"
            onClick={() => setSheetOpen(true)}
          >
            Menu
          </button>
        </div>
      </div>

      {sheetOpen ? (
        <div id="site-header-sheet" className="site-header-sheet" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="site-header-sheet-top">
            <Link href="/" aria-label="Matrix OS home" className="inline-flex items-center gap-2" onClick={() => setSheetOpen(false)}>
              <Logo className="h-7 w-auto" style={{ color: c.deep }} />
              <span
                className="whitespace-nowrap text-[15px] font-bold tracking-tight"
                style={{ color: c.deep, fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
              >
                Matrix OS
              </span>
            </Link>
            <button
              type="button"
              className="site-header-button site-header-button-dark"
              onClick={() => setSheetOpen(false)}
            >
              Close
            </button>
          </div>

          <nav className="site-header-sheet-nav" aria-label="Mobile">
            {sheetEntries.map((entry, index) =>
              entry.type === "group" ? (
                <p
                  key={entry.key}
                  className="site-header-sheet-group"
                  style={{ "--link-delay": `${index * 40}ms` } as React.CSSProperties}
                >
                  {entry.label}
                </p>
              ) : (
                <Link
                  key={entry.key}
                  href={entry.href}
                  className="site-header-sheet-link"
                  style={{ "--link-delay": `${index * 40}ms` } as React.CSSProperties}
                  onClick={() => setSheetOpen(false)}
                >
                  {entry.label}
                  <ArrowRightIcon className="size-5 shrink-0" style={{ color: c.subtle }} aria-hidden="true" />
                </Link>
              ),
            )}
          </nav>

          <div className="site-header-sheet-actions">
            <SignedOut>
              <a href="https://app.matrix-os.com" className="site-header-button site-header-button-soft" data-ph-event="marketing_cta_clicked" data-ph-location="mobile_menu" data-ph-target="sign_in">
                Sign in
              </a>
              <a href="https://app.matrix-os.com" className="site-header-button site-header-button-dark" data-ph-event="marketing_cta_clicked" data-ph-location="mobile_menu" data-ph-target="get_started">
                Get started
              </a>
            </SignedOut>
            <SignedIn>
              <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer" className="site-header-button site-header-button-dark" data-ph-event="marketing_cta_clicked" data-ph-location="mobile_menu" data-ph-target="open_app">
                Open Matrix OS
              </a>
            </SignedIn>
          </div>
        </div>
      ) : null}
    </header>
  );
}
