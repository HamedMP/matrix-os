import Link from "next/link";
import { GithubIcon, LinkedinIcon, MessageCircleIcon } from "lucide-react";
import { palette as c, cardShadow, fonts } from "./theme";
import { Logo } from "./Logo";

type FooterLinkItem = { label: string; href: string };

const footerColumns: ReadonlyArray<{ title: string; links: readonly FooterLinkItem[] }> = [
  {
    title: "Platform",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Symphony", href: "/symphony" },
      { label: "Hermes", href: "/hermes" },
      { label: "Pricing", href: "/#pricing" },
      { label: "Releases", href: "/releases" },
      { label: "Whitepaper", href: "/whitepaper" },
    ],
  },
  {
    title: "Solutions",
    links: [
      { label: "All solutions", href: "/solutions" },
      { label: "Use cases", href: "/use-cases" },
      { label: "Enterprise", href: "/solutions/enterprise-ai-coding-lab" },
      { label: "Universities", href: "/solutions/university-ai-development-lab" },
      { label: "Hermes hosting", href: "/solutions/hermes-ai-agent-hosting" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Quickstart", href: "/docs/quickstart" },
      { label: "Agent skill", href: "/skills.md" },
      { label: "Technical", href: "/technical" },
      { label: "Early access", href: "/early-access" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Contact", href: "/contact" },
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
];

const footerSocialIcons = [
  { label: "Discord", href: "https://discord.gg/cSBBQWtPwV", Icon: MessageCircleIcon },
  { label: "LinkedIn", href: "https://www.linkedin.com/company/matrix-os", Icon: LinkedinIcon },
  { label: "X", href: "https://x.com/joinmatrixos", Icon: null },
  { label: "GitHub", href: "https://github.com/HamedMP/matrix-os", Icon: GithubIcon },
] as const;

function FooterLink({ href, label }: FooterLinkItem) {
  const external = href.startsWith("http");
  const isStaticFile = href.endsWith(".md");
  if (external || isStaticFile) {
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className="landing-footer-link"
      >
        {label}
      </a>
    );
  }
  return (
    <Link href={href} className="landing-footer-link">
      {label}
    </Link>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer aria-label="Footer navigation" className="mx-auto w-full max-w-[1400px] px-5 pt-12 pb-6 md:px-10 md:pt-20 md:pb-10">
      <style>{`
        .landing-footer-link {
          position: relative;
          display: inline-block;
          font-size: 0.9375rem;
          line-height: 1;
          color: ${c.mutedFg};
          transition: color 0.2s ease;
        }
        .landing-footer-link::before {
          content: '';
          position: absolute;
          inset: -0.5rem -0.625rem;
          border-radius: 0.5rem;
          background: rgba(67, 78, 63, 0.07);
          opacity: 0;
          transform: scale(0.92);
          transition: opacity 0.2s ease, transform 0.2s ease;
          pointer-events: none;
        }
        .landing-footer-link:hover { color: ${c.deep}; }
        .landing-footer-link:hover::before { opacity: 1; transform: scale(1); }
      `}</style>

      <div
        className="rounded-2xl p-7 md:p-10"
        style={{ backgroundColor: c.card, boxShadow: cardShadow, fontFamily: fonts.sans }}
      >
        <div className="grid gap-10 md:grid-cols-[1fr_3fr]">
          <div>
            <Link href="/" aria-label="Matrix OS home" className="inline-flex items-center gap-2.5">
              <Logo className="h-9 w-auto" style={{ color: c.deep }} />
              <span
                className="text-[15px] font-bold tracking-tight"
                style={{ color: c.deep, fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
              >
                Matrix OS
              </span>
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:gap-x-8">
            {footerColumns.map((column) => (
              <div key={column.title}>
                <h3 className="mb-4 text-[0.75rem] font-medium" style={{ color: c.subtle }}>
                  {column.title}
                </h3>
                <ul className="flex flex-col gap-3.5">
                  {column.links.map((link) => (
                    <li key={link.href} className="flex flex-col items-start">
                      <FooterLink {...link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div
          className="mt-12 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderColor: c.border }}
        >
          <p className="text-[0.8125rem]" style={{ color: c.subtle }}>
            © {year} Matrix OS · AGPL-3.0-or-later
          </p>
          <div className="flex items-center gap-2">
            {footerSocialIcons.map(({ label, href, Icon }) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="inline-flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(67,78,63,0.07)]"
                style={{ color: c.mutedFg }}
              >
                {Icon ? <Icon className="size-4" strokeWidth={1.75} /> : (
                  <span className="text-[0.8125rem] font-semibold">X</span>
                )}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
