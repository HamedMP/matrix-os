import type { Metadata } from "next";
import Link from "next/link";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { ScrollScreenshot, BodyOverflow } from "@/components/landing/ScrollScreenshot";
import { LandingBilling } from "@/components/landing/LandingBilling";
import { LandingTelemetry } from "@/components/landing/LandingTelemetry";
import { AgentSetupCopyButton } from "@/components/landing/AgentSetupCopyButton";
import {
  ArrowRightIcon,
  BrainCircuitIcon,
  GithubIcon,
  GlobeIcon,
  LinkedinIcon,
  MessageCircleIcon,
  ShieldCheckIcon,
} from "lucide-react";

const faqItems = [
  { q: "What happens to my data?", a: "Everything is a file on your system. Apps, data, settings, your AI's memory. Copy a folder to back up your entire OS. No vendor lock-in. No opaque databases." },
  { q: "Do I need to code?", a: "No. You describe what you want in plain English. The AI writes the code, saves it as a file, and it appears on your desktop. You never touch a line of code unless you want to." },
  { q: "What if something breaks?", a: "The OS heals itself. A built-in agent monitors for problems and fixes them automatically. Everything is versioned with git, so nothing is ever truly lost." },
  { q: "Is it private?", a: "You can self-host it on your own server. Your data never leaves your machine unless you want it to. Open source under AGPL-3.0-or-later, auditable by anyone." },
  { q: "How is this different from ChatGPT?", a: "ChatGPT is a chat window that forgets you. Matrix OS is an operating system that remembers you, builds software for you, runs on every device, and works while you sleep." },
  { q: "What does it cost?", a: "Signup is free. Provisioning a hosted Matrix computer starts a 3-day trial through Clerk Billing because the private VPS has real runtime cost. The open source platform remains available for self-hosting." },
];

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", name: "Matrix OS", url: "https://matrix-os.com", logo: "https://matrix-os.com/rabbit.svg",
      sameAs: ["https://github.com/HamedMP/matrix-os", "https://x.com/joinmatrixos", "https://discord.gg/cSBBQWtPwV"] },
    { "@type": "SoftwareApplication", name: "Matrix OS", url: "https://matrix-os.com", applicationCategory: "OperatingSystem",
      operatingSystem: "Web, Docker", description: "An AI-native operating system that generates software from conversation.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
    { "@type": "FAQPage", mainEntity: faqItems.map((item) => ({
        "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })) },
  ],
});

const c = {
  forest: "#434E3F",
  deep: "#32352E",
  cream: "#E0E1CA",
  ember: "#D06F25",
  pageBg: "#E2E2CF",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
} as const;

type NavLinkConfig = {
  label: string;
  href: string;
};

const navLinks: NavLinkConfig[] = [
  { label: "features", href: "#features" },
  { label: "developers", href: "#developers" },
  { label: "billing", href: "#pricing" },
];

type FooterLinkItem = { label: string; href: string };

const footerProductLinks: readonly FooterLinkItem[] = [
  { label: "Docs", href: "/docs" },
  { label: "Releases", href: "/releases" },
  { label: "Agent Skill", href: "/skills.md" },
  { label: "Whitepaper", href: "/whitepaper" },
];

const footerLegalLinks: readonly FooterLinkItem[] = [
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
];

const footerSocialIcons = [
  { label: "Discord", href: "https://discord.gg/cSBBQWtPwV", Icon: MessageCircleIcon },
  { label: "LinkedIn", href: "https://www.linkedin.com/company/matrix-os", Icon: LinkedinIcon },
  { label: "X", href: "https://x.com/joinmatrixos", Icon: null },
  { label: "GitHub", href: "https://github.com/HamedMP/matrix-os", Icon: GithubIcon },
] as const;

const COPYABLE_AGENT_SETUP_PROMPT = `Set up Matrix OS so I can use my own cloud computer for coding agents.

First, read the official Matrix agent skill:
https://matrix-os.com/skills.md

Then install the Matrix CLI, help me sign in with matrix login, and start my preferred coding agent with matrix run.

Use Claude Code, Codex, OpenCode, Pi, Cursor, Gemini CLI, or another terminal agent if I ask for it.`;

const agentBrands = [
  { name: "Claude Code", logo: "/agents/claude-code.svg" },
  { name: "Codex", logo: "/agents/codex.svg" },
  { name: "Pi", logo: "/agents/pi.svg" },
  { name: "OpenCode", logo: "/agents/opencode.svg" },
  { name: "Cursor", logo: "/agents/cursor.svg" },
  { name: "Gemini CLI", logo: "/agents/gemini.svg" },
] as const;

export const metadata: Metadata = {
  title: "Matrix OS - Your computer, in the cloud",
  description:
    "An AI-native operating system that generates software from conversation. Open any browser, sign in, and your apps, files, and AI are ready.",
};

const LOGO_DEFAULT_STYLE: React.CSSProperties = {};

function Logo({ className = "", style = LOGO_DEFAULT_STYLE }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 503 660" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
      <path d="M39.92 591.8C29.34 590.89 23.34 592.01 14.08 597.64C2.72 608.91 -3.86 620.08 2.45 636.41C9.37 654.06 24.71 661.39 43.13 658.04C59.54 652.03 65.34 643.55 68.47 626.89C68.07 622.51 68.01 621.07 66.99 616.67C61.96 602.39 54.17 596.37 39.92 591.8Z" fill="currentColor"/>
      <path d="M106.71 536.72C102.31 536.06 94.59 536.63 90.52 538.17C58.6 550.26 66.72 588.64 99.25 591.34C117.98 592.89 128.44 581.86 145.24 576.98C152.58 574.86 163.91 575.12 171.26 577.81C188.79 585.69 204.58 594.98 224.4 587.8C232.55 584.84 243.08 579.22 247.13 570.79C254.58 571 261.07 570.52 268.5 569.96C272.44 575.66 275.27 579.07 280.83 583.06C291.6 590.45 302.94 589.17 312.74 580.34C328.37 566.76 313.98 545.03 296.16 545.2C283.89 545.32 275.61 552.67 267.7 560.85C261.14 560.64 254.38 560.71 247.8 560.71C227.72 539.85 207.88 533.74 181.85 547.92C147.98 566.37 136.59 541.37 106.71 536.72Z" fill="currentColor"/>
      <path d="M222.39 608.08C205.92 606.62 194.66 615.32 182.34 624.27C177.99 627.38 174.15 628.06 169.21 628.59C159.22 629.74 152.83 625.32 144.78 618.69C127.41 604.38 101.63 604.58 94.58 629.21C91.19 641.05 103.99 655.8 116.65 657.1C133.1 658.79 143.97 650.22 156.45 640.58C169.62 638.43 179.78 639.32 190.12 648.37C201.03 657.92 212.53 659.56 226.43 659.39C239.33 658.27 262.82 653.96 274.96 649.02C278.76 647.49 286.66 641.49 290.49 638.88C297.12 638.66 302.68 638.6 309.3 638.8C312.82 643.41 317.02 649.44 321.85 652.43C332.25 658.87 349.08 656.24 355.76 645.57C362.12 635.41 357.35 623.93 347.84 618.2C341.78 614.61 334.54 613.56 327.7 615.29C319.27 617.43 314.71 622.76 310.5 629.94C287.23 632.05 292.75 629.35 275.41 620.79C264.68 615.49 234.33 608.75 222.39 608.08Z" fill="currentColor"/>
      <path d="M411.14 613.08C382.86 611.31 378.26 653.8 409.3 655.61C415.61 655.67 420.99 655.4 426.19 651.4C430.5 648.08 433.26 643.14 433.85 637.73C435.37 623.7 424.29 614.41 411.14 613.08Z" fill="currentColor"/>
      <path d="M176.27 480.18C169.77 482.22 163.8 483.94 156.86 483.37C132.52 481.38 122.6 457.4 95.83 465.77C88.13 468.14 81.73 473.53 78.09 480.71C71.11 494.37 79.46 512.52 92.6 518.55C117.12 529.73 136.89 506.63 159.91 504.62C165.85 504.11 179.06 508.2 184.15 511.4C202.24 522.78 239.14 526.16 247.74 500.27C254.34 502.15 260.15 503.6 266.52 500.1C267.4 499.61 268.28 499.11 269.15 498.58C275.52 511.61 284.89 518.67 299.53 515.15C300.44 514.32 303.18 512.7 304.48 511.65C308.92 508.08 311.12 505.17 314.38 500.64C318.7 500.04 320.72 499.96 325.1 500.02C328.33 502.67 332.04 507.19 335.73 510.23C348.28 520.59 361.73 517.86 375.74 512.54C378.08 511.91 386.9 507.81 389.11 508.35C401.33 511.31 410.6 517.1 423.96 517.06C434.7 517.03 442.88 516.54 451.27 508.86C454.33 506.07 456.37 502.32 456.32 498.01C454.15 475.04 426.34 473.96 408.99 478.42C404.63 479.53 396.92 481.04 393.15 480.39C381.65 478.38 371.25 470.92 359.3 470.84C343.83 471.38 335.32 479.79 327.12 491.51C324.69 494.98 319.82 494.63 315.72 494.56C299.7 475.31 287.01 470.04 269.61 491.28C261.86 490.44 255.34 490.42 247.56 490.38C237.42 467.58 216.3 464.37 194.24 472.79C188.59 474.95 181.93 478.7 176.27 480.18Z" fill="currentColor"/>
      <path d="M306.05 423.81C270.8 387.46 252.72 420.46 215.55 415.24C188.7 411.48 173.55 381.21 141.73 404.37C135.9 411.42 132.66 417.19 133.5 426.77C134.28 434.82 138.28 442.22 144.6 447.27C153.02 454.15 161.4 455 171.79 453.86C172.47 453.47 179.56 451.86 182.69 450.39C190.01 446.96 199.66 440.71 207.2 438.92C236.92 431.85 250.85 461.15 283.35 450.78C294.5 447.22 298.55 444.77 304.72 433.89C313.37 434.04 315.81 434.23 322.8 429.68C322.54 429.65 349.67 475.9 370.1 431.78C371.02 431.65 371.94 431.53 372.87 431.43C380.98 430.56 383.13 433.27 389.07 438.46C400.65 447.64 422.64 445.46 436.55 444.84C452.57 444.13 463.51 426.5 448.13 415.18C445.97 413.59 443.5 412.48 440.87 411.92C438.75 411.45 433.43 410.97 431.32 410.99C417.54 411.02 397.74 404.44 387.49 416.44C372.87 433.56 371.53 424.27 360.14 414.09C348.6 403.78 330.51 413.54 324.48 425.6C323.26 428.03 320.3 424.61 318.58 424.39C314.6 423.69 310.15 423.86 306.05 423.81Z" fill="currentColor"/>
      <path d="M425.18 582.95C427.89 580.88 432.93 578.91 434.95 576.05C454.45 548.54 406.03 538.34 387.91 539.84C374.67 540.94 370.49 544.47 363.2 552.93C361.45 556.3 359.79 558.71 359.62 562.63C359.18 572.67 365.78 581.42 374.41 585.95C388.95 593.6 410.33 587.96 425.18 582.95Z" fill="currentColor"/>
      <path d="M149.46 93.42C149.07 93.39 148.68 93.37 148.29 93.36C143.9 93.21 139.63 94.88 136.5 97.96C127.55 106.69 132.78 119.08 142.93 123.61C147.7 125.74 151.5 125.37 156.56 125.38C168.48 132.8 167.31 137.06 169.42 149.54C172.96 168.8 193.76 185.13 213.44 180.32C226.76 177.06 228.19 174.81 239.24 183.97C238.78 197.41 243.19 210.21 254.04 218.69C264.11 226.57 277.01 229.88 289.63 227.83C304.08 225.4 309.33 221.1 322.59 231.57C325.27 243.22 328.15 251.1 340.99 254.26C354.42 254.9 362.53 245.03 358.23 232.25C355.24 223.37 344.86 216.24 335.51 218.52C333.56 219 330.78 220.59 328.92 221.61C321.87 218.18 316.78 212.81 312.61 206.3C312.57 188.52 295.54 170.16 279.56 164.22C276.54 163.1 267.75 161.71 265.89 160.38C265.89 160.23 265.99 157.05 266.08 157.31C263.39 149.93 259.1 140.87 253.69 135.24C248.24 129.57 239.9 132.34 233.16 130.29C222.88 125.81 216.16 118.2 204.46 116.87C195.14 115.8 189.51 118.75 180.69 119.73C175.91 120.27 169.17 116.18 165.79 112.82C162.86 102.64 160.42 96.06 149.46 93.42Z" fill="currentColor"/>
      <path d="M433.84 235.99C419.58 234 405.99 241.47 395.86 250.79C374.22 270.71 371.17 303.29 392.58 324.62C408.52 340.5 425.01 342.3 446.18 342.45C449.97 342.47 453.77 342.4 457.56 342.26C471.09 341.67 485.65 339.87 495.22 329.13C505.29 317.83 505.93 300.98 495.02 290C491.01 285.97 486.45 283.25 482.18 279.55C481.1 254.27 456.88 238.93 433.84 235.99Z" fill="currentColor"/>
      <path d="M247.33 0.12C243.58 -0.06 241.08 -0.31 237.67 1.73C229.51 6.62 227.48 16.28 232.43 24.32C237.69 32.87 244 31.47 252.46 33.5C252.93 33.9 253.39 34.32 253.84 34.75C268.7 48.93 258.82 57.18 264.06 73.97C269.21 90.46 281.58 103.35 298.28 108.34C305.03 110.36 312.46 109.43 319.39 109.22C326.27 112.54 329.16 116.81 331.92 123.59C329.61 133.6 328.33 141.49 334.05 150.86C340.38 161.24 350.67 164.92 361.94 166.87C368.54 168 373.7 173.56 376.81 179.19C379.17 183.01 374.92 186.53 374.26 190.1C371.83 203.27 380.63 211.62 392.19 214.73C392.57 214.74 392.96 214.74 393.35 214.75C398.56 214.69 403.53 212.5 407.08 208.68C410.28 205.27 411.95 200.7 411.69 196.03C411.23 187.56 405.16 179.61 397.48 176.42C393.31 174.68 390.91 175 386.52 175.23C382.92 169.32 379.97 164.75 377.81 158.07C382.81 143.09 384.96 130.72 372.58 118.15C363.65 109.07 353.81 110.06 342.04 110.16C329.78 89.6 337.18 94.71 336.69 74.92C336.51 67.88 333.29 60.67 329.55 54.83C309.81 24 282.86 38.96 264.33 21.18L263.8 20.66C263.51 9.54 257.96 2.86 247.33 0.12Z" fill="currentColor"/>
      <path d="M280.21 344.14C278.44 343.96 276.65 343.91 274.87 343.98C259.08 344.57 240.59 361.79 248.55 377.45C251.13 382.52 253.11 385.43 257.67 388.92C282.85 408.26 313.21 372.83 337.83 381.87C361.86 390.69 381.82 401.54 400.52 375.65C404.95 375.61 409.39 375.68 413.82 375.86C419.54 379.83 421.36 385.1 429.19 386.24C432.65 386.85 436.46 386.38 439.31 384.06C446.21 378.46 446.89 369.67 441.31 363.03C438.9 360.13 435.41 358.34 431.64 358.1C423.97 357.56 418.28 363.26 412.82 367.89C408.29 368.39 405.25 368.62 400.65 368.72C381.25 341.69 368.7 344.72 341.5 357.77C331.9 362.37 320.96 360.64 311.65 356.2C301.24 351.24 291.65 346.87 280.21 344.14Z" fill="currentColor"/>
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: "var(--font-inter), Inter, system-ui, sans-serif", position: "relative" }}>
      {/* react-doctor-disable-next-line react-doctor/no-danger -- jsonLd is JSON.stringify of a static module-scope object (trusted, no user input); standard JSON-LD injection */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <LandingTelemetry />
      <BodyOverflow />
      <svg style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 50, opacity: 0.12 }}>
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
      <style>{`
        .nav-link { position: relative; transition: color 0.25s ease; }
        .nav-link:hover { color: ${c.forest}; }
        .nav-link::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 100%; height: 1px; background: currentColor; transform: scaleX(0); transform-origin: right; transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
        .nav-link:hover::after { transform: scaleX(1); transform-origin: left; }
        .nav-chip {
          display: inline-flex;
          min-height: 2rem;
          align-items: center;
          justify-content: center;
          border-radius: 9999px;
          padding: 0 0.5rem;
          transition: color 0.25s ease, opacity 0.25s ease;
        }
        .nav-chip:hover {
          color: ${c.forest};
          opacity: 0.72;
        }

        .footer-link { transition: color 0.25s ease, opacity 0.25s ease; }
        .footer-link:hover { color: ${c.forest}; opacity: 1; }
        .footer-social:hover { color: ${c.forest}; border-color: ${c.mutedFg}; background-color: rgba(250, 250, 245, 0.9); }

        html { scroll-behavior: smooth; }

        .screenshot-wrapper {
          border-radius: 16px;
          overflow: hidden;
          transform: translateY(var(--ss-y, 0px)) scale(var(--ss-s, 1));
          box-shadow: 0 50px 100px -20px rgba(50,53,46,0.25), 0 30px 60px -30px rgba(50,53,46,0.3), 0 0 0 1px rgba(50,53,46,0.05);
          transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.6s ease;
        }
        .screenshot-wrapper:hover {
          transform: translateY(calc(var(--ss-y, 0px) - 8px)) scale(1.005);
          box-shadow: 0 60px 120px -20px rgba(50,53,46,0.3), 0 40px 80px -30px rgba(50,53,46,0.35), 0 0 0 1px rgba(50,53,46,0.08);
        }

        .nav-island {
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 100;
          width: fit-content;
          max-width: calc(100vw - 1rem);
        }
        .nav-island-inner {
          display: grid;
          grid-template-columns: max-content max-content;
          align-items: center;
          justify-content: start;
          column-gap: 0.45rem;
          width: 100%;
          min-height: 3rem;
          padding: 9px 0.75rem 9px 0.825rem;
          border-radius: 9999px;
          background: rgba(250, 250, 245, 0.96);
          backdrop-filter: blur(16px) saturate(1.8);
          -webkit-backdrop-filter: blur(16px) saturate(1.8);
          border: 1px solid ${c.border};
          box-shadow: 0 4px 24px rgba(50, 53, 46, 0.08), 0 1px 4px rgba(50, 53, 46, 0.04);
        }
        .nav-brand {
          grid-column: 1;
          justify-self: start;
          min-width: 0;
        }
        .nav-links {
          display: none;
        }
        .nav-actions {
          grid-column: 2;
          justify-self: end;
        }
        @media (max-width: 350px) {
          .nav-island-inner {
            column-gap: 0.35rem;
            padding: 8px 0.625rem;
          }
          .mobile-brand-wordmark {
            font-size: 11px;
          }
          .nav-actions a {
            padding-left: 0.625rem;
            padding-right: 0.625rem;
            letter-spacing: 0.08em;
          }
        }
        @media (min-width: 760px) {
          .nav-island {
            width: min(calc(100vw - 2rem), 39.5rem);
            max-width: none;
          }
          .nav-island-inner {
            grid-template-columns: auto minmax(0, 1fr) auto;
            justify-content: stretch;
            column-gap: 0.75rem;
            padding: 9px 1rem 9px 1.125rem;
          }
          .nav-brand {
            grid-column: 1;
          }
          .nav-links {
            grid-column: 2;
            justify-self: center;
            display: inline-flex;
            min-width: 0;
            align-items: center;
            gap: 1.05rem;
          }
          .nav-actions {
            grid-column: 3;
          }
        }
        @media (min-width: 1100px) {
          .nav-island {
            width: min(calc(100vw - 2rem), 50rem);
          }
          .nav-island-inner {
            grid-template-columns: auto minmax(0, 1fr) auto;
            column-gap: 1.25rem;
            padding: 10px 1.75rem 10px 1.5rem;
          }
          .nav-brand {
            grid-column: 1;
          }
          .nav-links {
            grid-column: 2;
            justify-self: center;
            gap: 0.35rem;
          }
          .nav-actions {
            grid-column: 3;
          }
        }
        @media (min-width: 1280px) {
          .nav-island-inner {
            column-gap: 1.5rem;
            padding: 11px 2rem 11px 1.75rem;
          }
          .nav-links {
            gap: 2.25rem;
          }
        }
      `}</style>

      <NavIsland />
      <HeroSection />
      <AgentSetupSection />
      <PreviewSection />
      <AboutSection />

      <div className="mx-auto max-w-[1100px] px-8">
        <div style={{ height: 1, backgroundColor: c.border }} />
      </div>

      <FeaturesSection />
      <HowItWorksSection />

      <LandingBilling />

      <FaqSection />
      <FinalCtaSection />
      <SiteFooter />
    </div>
  );
}

function AgentSetupSection() {
  return (
    <section id="developers" className="relative pt-12 pb-8 md:pt-14 md:pb-10" style={{ backgroundColor: c.pageBg }}>
      <div className="mx-auto max-w-[1100px] px-6 md:px-8">
        <div className="grid gap-8 md:grid-cols-[0.88fr_1.12fr] md:items-stretch">
          <div className="flex flex-col justify-center">
            <p className="mb-5 text-[11px] uppercase tracking-[0.3em]" style={{ color: c.subtle }}>For coding agents</p>
            <h2 className="mb-5 max-w-xl text-[clamp(1.8rem,4vw,3.2rem)] font-semibold leading-[1.12]" style={{ color: c.forest }}>
              Paste one message. Let your agent install Matrix.
            </h2>
            <p className="max-w-xl text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
              Matrix publishes a setup skill at <code>matrix-os.com/skills.md</code>. Give it to Claude Code, Codex, Pi, OpenCode, Cursor, Gemini CLI, or another coding agent so it can install the CLI, guide <code>matrix login</code>, and start work on your cloud computer with <code>matrix run</code>.
            </p>
            <div className="mt-7 flex flex-wrap gap-3" aria-label="Supported coding agents">
              {agentBrands.map((brand) => (
                <div
                  key={brand.name}
                  className="inline-flex min-h-11 items-center gap-2.5 rounded-full px-3.5 text-[12px] font-medium"
                  style={{ border: `1px solid ${c.border}`, backgroundColor: "rgba(250,250,245,0.36)", color: c.forest }}
                >
                  <img
                    src={brand.logo}
                    alt=""
                    aria-hidden="true"
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded-md object-contain"
                  />
                  {brand.name}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[16px] p-5 md:p-6" style={{ backgroundColor: "rgba(67,78,63,0.07)", border: `1px solid ${c.border}` }}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-[11px] uppercase tracking-[0.2em]" style={{ color: c.subtle }}>Copy for your agent</p>
              <AgentSetupCopyButton text={COPYABLE_AGENT_SETUP_PROMPT} />
            </div>
            <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap rounded-[12px] p-4 text-left text-[12px] leading-[1.75]"
              style={{ backgroundColor: "rgba(250,250,245,0.54)", color: c.forest, border: `1px solid ${c.border}` }}>
              <code>{COPYABLE_AGENT_SETUP_PROMPT}</code>
            </pre>
            <nav className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-label="Agent setup resources">
              {/* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- /skills.md is a static public file, not a Next route; Link would prefetch/client-navigate raw markdown */}
              <a href="/skills.md" className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-center text-[10px] font-medium uppercase tracking-[0.08em] transition-opacity duration-300 hover:opacity-80 sm:px-4 sm:text-[11px] sm:tracking-[0.12em]"
                style={{ border: `1px solid ${c.border}`, color: c.forest }}>
                Open skills.md <ArrowRightIcon className="size-3.5" />
              </a>
              <Link href="/docs/guide/developer-workflow" className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-center text-[10px] font-medium uppercase tracking-[0.08em] transition-opacity duration-300 hover:opacity-80 sm:px-4 sm:text-[11px] sm:tracking-[0.12em]"
                style={{ border: `1px solid ${c.border}`, color: c.forest }}>
                Developer workflow
              </Link>
            </nav>
          </div>
        </div>
      </div>
    </section>
  );
}

function NavLinkItem({ link }: { link: NavLinkConfig }) {
  return (
    <a
      href={link.href}
      className="nav-chip shrink-0 whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.12em]"
      style={{ color: c.mutedFg }}
    >
      {link.label}
    </a>
  );
}

function NavIsland() {
  return (
    <div className="nav-island">
      <div className="nav-island-inner">
        <Link
          href="/"
          className="nav-brand flex items-center gap-2"
          style={{ fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
        >
          <Logo className="h-6 w-auto shrink-0 min-[380px]:h-7 min-[1100px]:h-8" style={{ color: c.forest }} />
          <span className="mobile-brand-wordmark whitespace-nowrap text-[12px] font-bold tracking-tight min-[380px]:text-[13px] min-[1100px]:text-[15px] min-[1280px]:text-base" style={{ color: c.forest }}>
            Matrix OS
          </span>
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {navLinks.map((link) => (
            <NavLinkItem key={link.href} link={link} />
          ))}
        </nav>
        <div className="nav-actions">
          <SignedOut>
            <a
              href="https://app.matrix-os.com"
              data-ph-event="marketing_cta_clicked"
              data-ph-location="nav"
              data-ph-target="get_started"
              className="inline-flex shrink-0 rounded-full px-3 py-2 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors duration-200 min-[1280px]:px-5"
              style={{ backgroundColor: c.forest, color: c.pageBg }}
            >
              get started
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="https://app.matrix-os.com"
              data-ph-event="marketing_cta_clicked"
              data-ph-location="nav"
              data-ph-target="open_app"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 rounded-full px-3 py-2 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors duration-200 min-[1280px]:px-5"
              style={{ backgroundColor: c.forest, color: c.pageBg }}
            >
              open matrix os
            </a>
          </SignedIn>
        </div>
      </div>
    </div>
  );
}

function HeroSection() {
  return (
    <section className="relative min-h-[78svh] overflow-hidden pt-32 pb-20 md:min-h-[82svh] md:pt-28 md:pb-24" style={{ backgroundColor: c.pageBg }}>
      <div className="relative mx-auto grid min-h-[calc(78svh-13rem)] max-w-[980px] items-center gap-8 px-6 md:min-h-[calc(82svh-13rem)] md:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] md:gap-10 md:px-8 lg:max-w-[1040px] lg:gap-12">
        <div className="relative z-10 max-w-[22rem] md:max-w-[26rem]">
          <h1 className="text-[2.65rem] md:text-[3.25rem] leading-[1.1] mb-6" style={{ color: c.forest }}>
            Your computer, in the cloud.
          </h1>
          <p className="text-[16px] leading-[1.8] mb-8" style={{ color: c.mutedFg }}>
            A personal computer that lives in the cloud. Open any browser, sign in, and everything is ready: your apps, your files, your way.
          </p>
          <SignedOut>
            <a href="https://app.matrix-os.com" data-ph-event="marketing_cta_clicked" data-ph-location="hero" data-ph-target="get_started" className="inline-flex items-center gap-2 rounded-full px-8 py-3 text-[13px] tracking-[0.12em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
              style={{ backgroundColor: c.forest, color: c.pageBg }}>
              Get Started <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedOut>
          <SignedIn>
            <a href="https://app.matrix-os.com" data-ph-event="marketing_cta_clicked" data-ph-location="hero" data-ph-target="open_app" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full px-8 py-3 text-[13px] tracking-[0.12em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
              style={{ backgroundColor: c.forest, color: c.pageBg }}>
              Open Matrix OS <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedIn>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <a
              href="https://discord.gg/cSBBQWtPwV"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link text-[11px] tracking-[0.16em] uppercase"
              style={{ color: c.subtle }}
            >
              Join Discord
            </a>
            {/* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- /skills.md is a static public file, not a Next route; Link would prefetch/client-navigate raw markdown */}
            <a
              href="/skills.md"
              className="nav-link text-[11px] tracking-[0.16em] uppercase"
              style={{ color: c.subtle }}
            >
              Agent setup
            </a>
          </div>
        </div>
        <div className="relative z-0 mx-auto w-full max-w-[340px] md:mx-0 md:max-w-none md:justify-self-end">
          <video
            autoPlay
            loop
            muted
            playsInline
            aria-hidden="true"
            tabIndex={-1}
            preload="metadata"
            controls={false}
            src="/hero-loop.mp4"
            className="block aspect-[4/3] w-full object-contain object-center md:aspect-[16/11] md:max-w-[420px]"
            style={{ backgroundColor: c.pageBg }}
          />
        </div>
      </div>
    </section>
  );
}

function PreviewSection() {
  return (
    <section id="preview" className="relative overflow-hidden pt-8 pb-14 md:pt-12 md:pb-20" style={{ backgroundColor: c.pageBg }}>
      <div className="mx-auto max-w-[1100px] px-8">
        <ScrollScreenshot />
        <div className="mt-10 max-w-2xl mx-auto text-center">
          <h3 className="text-[1.1rem] font-semibold mb-3" style={{ color: c.forest }}>A real desktop, in your browser</h3>
          <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
            Your Matrix instance isn&apos;t just a dashboard: it&apos;s a full visual operating system. A desktop with windows, a dock, wallpapers, and all your apps arranged exactly how you like. It feels like sitting at your own computer, except it runs in the cloud and follows you everywhere.
          </p>
        </div>
      </div>
    </section>
  );
}

function AboutSection() {
  return (
    <section id="about" className="py-16 md:py-24" style={{ backgroundColor: c.pageBg }}>
      <div className="mx-auto max-w-[1100px] px-8">
        <div className="grid gap-12 md:grid-cols-[1fr_1.2fr] md:gap-16">
          <div>
            <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>About</p>
            <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.2]" style={{ color: c.forest }}>
              Your computer, in the cloud.
            </h2>
          </div>
          <div className="flex flex-col gap-6 md:pt-10">
            <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
              Matrix OS gives you a full personal computer that runs in the cloud. Open any browser, sign in, and you have your desktop: your apps, your files, your settings, ready to go. No installs, no setup, nothing to maintain.
            </p>
            <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
              Just tell it what you need. An AI assistant builds your apps, organizes your workspace, and keeps everything running. It works on any device, from anywhere, and picks up right where you left off.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

const featureNetworkLines = [
  { x: 200, y: 42, anim: "line-blink", delay: "0s" },
  { x: 348, y: 108, anim: "line-steady", delay: "1s" },
  { x: 350, y: 292, anim: "line-blink", delay: "3s" },
  { x: 200, y: 358, anim: "line-steady", delay: "0.5s" },
  { x: 50, y: 292, anim: "line-blink", delay: "5s" },
  { x: 52, y: 108, anim: "line-steady", delay: "2s" },
] as const;

const featureNetworkDevices = [
  { x: 200, y: 42, anim: "device-blink", delay: "0s", label: "Mobile", icon: "smartphone" as const },
  { x: 348, y: 108, anim: "device-steady", delay: "1s", label: "Laptop", icon: "laptop" as const },
  { x: 350, y: 292, anim: "device-blink", delay: "3s", label: "Tablet", icon: "tablet" as const },
  { x: 200, y: 358, anim: "device-steady", delay: "0.5s", label: "Computer", icon: "monitor" as const },
  { x: 50, y: 292, anim: "device-blink", delay: "5s", label: "Friend's PC", icon: "laptop" as const },
  { x: 52, y: 108, anim: "device-steady", delay: "2s", label: "Browser", icon: "globe" as const },
] as const;

const featurePills = [
  { Icon: BrainCircuitIcon, title: "Always running", desc: "Your instance never sleeps. Apps, data, and AI stay online 24/7 whether you're connected or not." },
  { Icon: ShieldCheckIcon, title: "Private by design", desc: "Your own database, files, and runtime. Fully isolated. Nobody else can see in." },
  { Icon: GlobeIcon, title: "Any screen, anywhere", desc: "Phone, laptop, friend's computer: open a browser and you're home." },
] as const;

function FeaturesSection() {
  return (
    <section id="features" className="relative overflow-hidden py-16 md:py-24" style={{ backgroundColor: c.pageBg }}>
      <style>{`
        @keyframes net-flow { 0% { stroke-dashoffset: 24; } 100% { stroke-dashoffset: 0; } }
        @keyframes center-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @keyframes center-ring { 0% { r: 52; opacity: 0.35; } 100% { r: 96; opacity: 0; } }
        @keyframes glow-breathe { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.45; } }
        @keyframes device-online { 0%, 15% { opacity: 1; } 20%, 100% { opacity: 0.72; } }
        @keyframes device-online-long { 0%, 60% { opacity: 1; } 65%, 100% { opacity: 0.72; } }
        @keyframes line-active { 0%, 15% { stroke-opacity: 0.55; } 20%, 100% { stroke-opacity: 0.22; } }
        @keyframes line-active-long { 0%, 60% { stroke-opacity: 0.55; } 65%, 100% { stroke-opacity: 0.22; } }
        .net-line-flow {
          stroke-dasharray: 6 6;
          animation: net-flow 1.8s linear infinite, var(--line-state-animation);
        }
        .center-hub {
          animation: center-pulse 5s ease-in-out infinite;
          transform-box: fill-box;
          transform-origin: center;
        }
        .center-ring-ping { animation: center-ring 3s ease-out infinite; }
        .net-glow { animation: glow-breathe 5s ease-in-out infinite; }
        .device-blink { animation: device-online 8s ease-in-out infinite; }
        .device-steady { animation: device-online-long 10s ease-in-out infinite; }
        .line-blink { --line-state-animation: line-active 8s ease-in-out infinite; }
        .line-steady { --line-state-animation: line-active-long 10s ease-in-out infinite; }
        .feature-pill { backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .feature-pill:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
      `}</style>

      <div className="mx-auto max-w-[1200px] px-8">
        <div className="mb-10 grid items-center gap-10 md:mb-14 md:grid-cols-2 md:gap-14">
          <div>
            <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>The platform</p>
            <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.15] mb-8" style={{ color: c.forest }}>
              Built around you.
            </h2>
            <p className="text-[15px] leading-[1.9] mb-5" style={{ color: c.mutedFg }}>
              Your Matrix instance runs 24/7 in the cloud, always on and always yours. Connect from your phone on the train, your laptop at home, or a friend&apos;s computer at a cafe. Every device sees the same workspace, instantly.
            </p>
            <p className="text-[15px] leading-[1.9]" style={{ color: c.subtle }}>
              Devices come and go. Your instance never stops. Close your laptop and pick up on your phone, with everything exactly where you left it. No syncing, no waiting, no setup.
            </p>
          </div>

          <FeatureNetworkDiagram />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {featurePills.map((item) => (
            <div key={item.title} className="feature-pill rounded-[16px] p-6 h-full"
              style={{ backgroundColor: "rgba(67,78,63,0.06)", border: `1px solid ${c.border}` }}>
              <item.Icon className="size-5 mb-4" style={{ color: c.ember }} />
              <h3 className="text-[14px] font-semibold mb-2" style={{ color: c.forest }}>{item.title}</h3>
              <p className="text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureNetworkDiagram() {
  return (
    <div className="relative w-full" style={{ aspectRatio: "1 / 1", maxWidth: 560, margin: "0 auto" }}>
      <svg viewBox="0 0 400 400" className="h-full w-full" style={{ overflow: "visible" }} aria-label="Matrix instance connected to phones, laptops, tablets, and browsers">
        <defs>
          <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={c.ember} stopOpacity="0.35" />
            <stop offset="70%" stopColor={c.ember} stopOpacity="0.08" />
            <stop offset="100%" stopColor={c.ember} stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx="200" cy="200" r="132" fill="url(#center-glow)" className="net-glow" />

        <circle cx="200" cy="200" r="52" fill="none" stroke={c.ember} strokeWidth="1.2" className="center-ring-ping" />
        <circle cx="200" cy="200" r="52" fill="none" stroke={c.ember} strokeWidth="0.8" className="center-ring-ping" style={{ animationDelay: "1s" }} />
        <circle cx="200" cy="200" r="52" fill="none" stroke={c.ember} strokeWidth="0.5" className="center-ring-ping" style={{ animationDelay: "2s" }} />

        {featureNetworkLines.map((node, i) => (
          <line key={`line-${i}`} x1="200" y1="200" x2={node.x} y2={node.y}
            stroke="rgba(67,78,63,0.45)" strokeWidth="2.2"
            className={`net-line-flow ${node.anim}`}
            style={{ animationDelay: `${node.delay}, ${node.delay}` }} />
        ))}

        <g className="center-hub">
          <circle cx="200" cy="200" r="52" fill="rgba(208,111,37,0.14)" stroke={c.ember} strokeWidth="2" />
          <circle cx="200" cy="200" r="34" fill={c.ember} opacity="0.92" />
        </g>

        {featureNetworkDevices.map((node, i) => (
          <g key={`device-${i}`} className={node.anim} style={{ animationDelay: node.delay }}>
            <circle cx={node.x} cy={node.y} r="34" fill="rgba(250,250,245,0.72)" stroke="rgba(67,78,63,0.35)" strokeWidth="1.5" />
            {node.icon === "smartphone" && (
              <rect x={node.x - 6} y={node.y - 10} width="12" height="20" rx="2.5" fill="none" stroke={c.forest} strokeWidth="1.6" />
            )}
            {node.icon === "laptop" && (<>
              <rect x={node.x - 11} y={node.y - 7} width="22" height="14" rx="2" fill="none" stroke={c.forest} strokeWidth="1.6" />
              <line x1={node.x - 13} y1={node.y + 8} x2={node.x + 13} y2={node.y + 8} stroke={c.forest} strokeWidth="1.6" />
            </>)}
            {node.icon === "tablet" && (
              <rect x={node.x - 8} y={node.y - 11} width="16" height="22" rx="2.5" fill="none" stroke={c.forest} strokeWidth="1.6" />
            )}
            {node.icon === "monitor" && (<>
              <rect x={node.x - 12} y={node.y - 10} width="24" height="16" rx="2" fill="none" stroke={c.forest} strokeWidth="1.6" />
              <line x1={node.x} y1={node.y + 7} x2={node.x} y2={node.y + 11} stroke={c.forest} strokeWidth="1.6" />
              <line x1={node.x - 6} y1={node.y + 11} x2={node.x + 6} y2={node.y + 11} stroke={c.forest} strokeWidth="1.6" />
            </>)}
            {node.icon === "globe" && (
              <g>
                <circle cx={node.x} cy={node.y} r="10" fill="none" stroke={c.forest} strokeWidth="1.6" />
                <ellipse cx={node.x} cy={node.y} rx="5" ry="10" fill="none" stroke={c.forest} strokeWidth="1" />
                <line x1={node.x - 10} y1={node.y} x2={node.x + 10} y2={node.y} stroke={c.forest} strokeWidth="1" />
              </g>
            )}
            <text x={node.x} y={node.y + 48} textAnchor="middle" dominantBaseline="central"
              fill={c.forest} fontSize="9.5" fontWeight="600" letterSpacing="0.08em"
              fontFamily="var(--font-inter), Inter, sans-serif">
              {node.label.toUpperCase()}
            </text>
          </g>
        ))}

        <text x="200" y="194" textAnchor="middle" dominantBaseline="central"
          fill="#FAFAF5" fontSize="9" fontWeight="700" letterSpacing="0.14em"
          fontFamily="var(--font-orbitron), Orbitron, sans-serif">
          MATRIX
        </text>
        <text x="200" y="208" textAnchor="middle" dominantBaseline="central"
          fill="rgba(250,250,245,0.85)" fontSize="7.5" fontWeight="600" letterSpacing="0.12em"
          fontFamily="var(--font-inter), Inter, sans-serif">
          24/7
        </text>
      </svg>
    </div>
  );
}

const howItWorksSteps = [
  { step: "01", title: "Create a free account", desc: "Sign up in seconds. No credit card, no setup wizard, no downloads." },
  { step: "02", title: "Start the hosted trial", desc: "When you provision a Matrix computer, Clerk starts the 3-day trial and collects the card required for the private VPS." },
  { step: "03", title: "Bring your own agent", desc: "Connect your preferred AI: Claude, GPT, Hermes, or any model you trust. Your instance, your agent, your rules." },
] as const;

function HowItWorksSection() {
  return (
    <section className="py-14 md:py-20" style={{ backgroundColor: c.pageBg }}>
      <div className="mx-auto max-w-[1100px] px-8">
        <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>How It Works</p>
        <h2 className="mb-8 text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.2] md:mb-12" style={{ color: c.forest }}>
          Free to start, deliberate when you provision.
        </h2>

        <div className="grid gap-8 md:grid-cols-3 md:gap-10">
          {howItWorksSteps.map((item) => (
            <div key={item.step}>
              <span className="block text-[clamp(2.5rem,5vw,4rem)] font-bold leading-none mb-5" style={{ color: c.border }}>
                {item.step}
              </span>
              <h3 className="text-[16px] font-semibold mb-3" style={{ color: c.forest }}>{item.title}</h3>
              <p className="text-[14px] leading-[1.8]" style={{ color: c.mutedFg }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="py-14 md:py-20" style={{ backgroundColor: c.pageBg }}>
      <div className="mx-auto max-w-[900px] px-8">
        <p className="text-[11px] tracking-[0.3em] uppercase mb-6 text-center" style={{ color: c.subtle }}>FAQ</p>
        <div className="grid gap-4 md:grid-cols-2">
          {faqItems.map((item) => (
            <div key={item.q} className="rounded-[16px] p-6" style={{ backgroundColor: "rgba(67,78,63,0.05)", border: `1px solid ${c.border}` }}>
              <h3 className="text-[14px] font-semibold mb-3" style={{ color: c.forest }}>{item.q}</h3>
              <p className="text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCtaSection() {
  return (
    <section className="py-14 md:py-20" style={{ backgroundColor: c.pageBg }}>
      <div className="mx-auto max-w-[1100px] px-8 text-center">
        <h2 className="text-[clamp(2rem,6vw,4.5rem)] font-bold leading-[1.1] mb-6" style={{ color: c.forest }}>
          Ready to begin?
        </h2>
        <p className="text-[15px] mb-10 max-w-md mx-auto" style={{ color: c.mutedFg }}>
          Your personal cloud computer is waiting. Set up takes less than a minute.
        </p>
        <SignedOut>
          <a href="https://app.matrix-os.com" className="inline-flex items-center gap-2 rounded-full px-10 py-4 text-[13px] tracking-[0.15em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
            style={{ backgroundColor: c.forest, color: c.pageBg }}>
            Get Started Free <ArrowRightIcon className="size-4" />
          </a>
        </SignedOut>
        <SignedIn>
          <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full px-10 py-4 text-[13px] tracking-[0.15em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
            style={{ backgroundColor: c.forest, color: c.pageBg }}>
            Go to Dashboard <ArrowRightIcon className="size-4" />
          </a>
        </SignedIn>
        <p className="mt-5 text-[12px] leading-6" style={{ color: c.subtle }}>
          By using Matrix OS, you agree to the{" "}
          <Link href="/terms" className="underline decoration-current/40 underline-offset-4 transition-opacity hover:opacity-70">
            Terms
          </Link>{" "}
          and acknowledge the{" "}
          <Link href="/privacy" className="underline decoration-current/40 underline-offset-4 transition-opacity hover:opacity-70">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

function FooterLink({ href, label }: FooterLinkItem) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="footer-link text-[12px] leading-snug"
      style={{ color: c.mutedFg }}
    >
      {label}
    </a>
  );
}

function FooterColumn({ title, links }: { title: string; links: readonly FooterLinkItem[] }) {
  return (
    <div>
      <p
        className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={{ color: c.subtle }}
      >
        {title}
      </p>
      <ul className="flex flex-col gap-1.5">
        {links.map((link) => (
          <li key={link.href}>
            <FooterLink {...link} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer
      className="border-t py-10"
      style={{ backgroundColor: c.pageBg, borderColor: c.border }}
    >
      <div className="mx-auto max-w-[1100px] px-6 md:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-4">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2.5"
              style={{ fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
            >
              <Logo className="h-7 w-auto shrink-0" style={{ color: c.forest }} />
              <span
                className="whitespace-nowrap text-[15px] font-bold tracking-tight"
                style={{ color: c.forest }}
              >
                matrix os
              </span>
            </Link>
            <div className="flex flex-wrap items-center gap-1.5">
              {footerSocialIcons.map(({ label, href, Icon }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="footer-social inline-flex size-8 items-center justify-center rounded-full border transition-colors"
                  style={{ borderColor: c.border, color: c.mutedFg, backgroundColor: "rgba(250, 250, 245, 0.5)" }}
                >
                  {Icon ? <Icon className="size-3.5" strokeWidth={1.75} /> : (
                    <span className="text-[10px] font-semibold">X</span>
                  )}
                </a>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-10 gap-y-6 sm:gap-x-14">
            <FooterColumn title="Product" links={footerProductLinks} />
            <FooterColumn title="Legal" links={footerLegalLinks} />
          </div>
        </div>

        <div
          className="mt-8 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderColor: c.border }}
        >
          <p className="text-[11px]" style={{ color: c.subtle }}>
            © {year} Matrix OS · AGPL-3.0-or-later
          </p>
          <div className="flex items-center gap-5">
            <SignedOut>
              <a
                href="https://app.matrix-os.com"
                className="footer-link text-[11px] font-medium tracking-[0.1em] uppercase"
                style={{ color: c.forest }}
              >
                Sign In
              </a>
            </SignedOut>
            <SignedIn>
              <a
                href="https://app.matrix-os.com"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-link inline-flex items-center gap-1 text-[11px] font-medium tracking-[0.1em] uppercase"
                style={{ color: c.forest }}
              >
                Open App
                <ArrowRightIcon className="size-3" strokeWidth={2} />
              </a>
            </SignedIn>
          </div>
        </div>
      </div>
    </footer>
  );
}
