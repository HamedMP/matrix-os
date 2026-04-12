"use client";

import { useState, useRef, useEffect } from "react";

const segments = [
  {
    id: "you",
    label: "For you",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M20 21a8 8 0 0 0-16 0" />
      </svg>
    ),
    headline: "Your personal chief of staff",
    desc: "An AI that handles the busywork so you can focus on what matters. It reads your email, tracks your money, remembers your habits, and nudges you before deadlines.",
    cases: [
      {
        ask: "Summarize my emails every morning and text me the highlights",
        result: "A daily briefing at 8am that reads your inbox, flags what's urgent, and messages you on Telegram.",
        icon: "mail",
      },
      {
        ask: "Track my expenses and tell me where my money goes",
        result: "A personal finance app that categorizes spending and shows trends -- built in seconds, saved as a file.",
        icon: "chart",
      },
      {
        ask: "Build me a workout log that learns what I like",
        result: "A fitness tracker that adapts to your history, suggests exercises, and remembers your preferences.",
        icon: "activity",
      },
      {
        ask: "Remind me about bills before they're due",
        result: "A monitoring agent that watches your deadlines and sends WhatsApp reminders 3 days ahead.",
        icon: "bell",
      },
    ],
  },
  {
    id: "people",
    label: "For your people",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="7" r="3.5" />
        <circle cx="17" cy="7" r="3.5" />
        <path d="M13 21a6 6 0 0 0-10 0" />
        <path d="M23 21a6 6 0 0 0-7.5-5.5" />
      </svg>
    ),
    headline: "One AI for the whole household",
    desc: "Shared tools that keep everyone on the same page. Family, roommates, study groups -- everyone adds from their own device, everyone sees the same data.",
    cases: [
      {
        ask: "Make a grocery list the whole family can add to from any app",
        result: "A shared list accessible from Telegram, WhatsApp, or the web -- anyone adds items, everyone sees updates.",
        icon: "list",
      },
      {
        ask: "Build a bedtime story generator for my kids",
        result: "A story app that knows your children's names, favorite characters, and reading level.",
        icon: "book",
      },
      {
        ask: "Plan our group trip to Portugal and track who paid what",
        result: "A trip planner with shared itinerary, expense splitting, and automatic reminders for everyone.",
        icon: "map",
      },
      {
        ask: "Create a chore chart that rotates weekly and nags the right person",
        result: "A household scheduler that assigns tasks, sends reminders on each person's preferred channel.",
        icon: "calendar",
      },
    ],
  },
  {
    id: "work",
    label: "For your work",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" />
        <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
        <path d="M12 12h.01" />
      </svg>
    ),
    headline: "A developer, assistant, and sysadmin in one",
    desc: "The tools your business needs, built overnight, running by morning. Monitor deploys, draft support replies, audit clients, build internal tools -- without hiring.",
    cases: [
      {
        ask: "Watch my GitHub deploys and text me if anything fails",
        result: "A monitoring agent that checks every 5 minutes and messages you on Telegram with the error log.",
        icon: "terminal",
      },
      {
        ask: "Build a CRM that matches how we actually sell",
        result: "A custom CRM with your exact pipeline stages, deal fields, and reporting -- built for your process.",
        icon: "database",
      },
      {
        ask: "Check our 5 client websites for uptime and SEO changes daily",
        result: "An automated audit that runs at 6am, flags problems, and creates a report ready before standup.",
        icon: "search",
      },
      {
        ask: "Draft responses to support tickets using our docs",
        result: "An agent that reads your knowledge base, matches the issue, and drafts a reply you approve and send.",
        icon: "reply",
      },
    ],
  },
];

function CaseIcon({ type }: { type: string }) {
  const icons: Record<string, JSX.Element> = {
    mail: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    ),
    chart: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" /><path d="m7 16 4-8 4 5 5-9" />
      </svg>
    ),
    activity: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
    bell: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    ),
    list: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6h11M9 12h11M9 18h11M5 6h.01M5 12h.01M5 18h.01" />
      </svg>
    ),
    book: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
      </svg>
    ),
    map: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 7 6-3 6 3 6-3v13l-6 3-6-3-6 3Z" /><path d="m9 4v13M15 7v13" />
      </svg>
    ),
    calendar: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    ),
    terminal: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4 17 6-6-6-6M12 19h8" />
      </svg>
    ),
    database: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
      </svg>
    ),
    search: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
      </svg>
    ),
    reply: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m9 17-5-5 5-5" /><path d="M4 12h12a4 4 0 0 1 4 4v1" />
      </svg>
    ),
  };
  return icons[type] || null;
}

export function UseCasesTabs() {
  const [active, setActive] = useState(0);
  const [animating, setAnimating] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  function switchTab(idx: number) {
    if (idx === active || animating) return;
    setAnimating(true);

    if (contentRef.current) {
      contentRef.current.style.opacity = "0";
      contentRef.current.style.transform = "translateY(12px)";
    }

    setTimeout(() => {
      setActive(idx);
      if (contentRef.current) {
        contentRef.current.style.transition = "none";
        contentRef.current.style.opacity = "0";
        contentRef.current.style.transform = "translateY(12px)";

        requestAnimationFrame(() => {
          if (contentRef.current) {
            contentRef.current.style.transition = "opacity 0.35s ease-out, transform 0.35s ease-out";
            contentRef.current.style.opacity = "1";
            contentRef.current.style.transform = "translateY(0)";
          }
          setTimeout(() => setAnimating(false), 350);
        });
      }
    }, 200);
  }

  const seg = segments[active];

  return (
    <section id="use-cases" className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">
          Built for how you live and work
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr] gap-12 items-start mb-12">
          <h2
            className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em]"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Software that fits{" "}
            <span className="italic">your life</span>
          </h2>
          <p className="text-[var(--ink)]/55 leading-relaxed md:pt-2">
            Not a template. Not an app store download. You describe exactly
            what you need, and your AI builds it -- tailored to your
            situation, saved as files you own.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2 mb-10 overflow-x-auto pb-1">
          {segments.map((s, i) => (
            <button
              key={s.id}
              onClick={() => switchTab(i)}
              className={`
                inline-flex items-center gap-2.5 px-5 py-2.5 rounded-full text-sm font-medium
                transition-all duration-200 shrink-0 cursor-pointer
                ${active === i
                  ? "bg-[var(--forest)] text-[var(--stone)] shadow-lg shadow-[var(--forest)]/15"
                  : "bg-[var(--stone)] text-[var(--ink)]/60 border border-[var(--pebble)] hover:border-[var(--moss)]/40 hover:text-[var(--ink)]"
                }
              `}
            >
              <span className={active === i ? "text-[var(--sage)]" : "text-[var(--moss)]"}>
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div
          ref={contentRef}
          style={{ transition: "opacity 0.2s ease-out, transform 0.2s ease-out" }}
        >
          {/* Persona header */}
          <div className="rounded-2xl bg-[var(--forest)] text-[var(--stone)] p-8 sm:p-10 mb-6">
            <div className="flex flex-col md:flex-row md:items-center gap-6">
              {/* Decorative persona icon */}
              <div className="shrink-0 w-16 h-16 rounded-2xl bg-[var(--sage)]/15 flex items-center justify-center text-[var(--sage)]">
                <div className="scale-[1.8]">{seg.icon}</div>
              </div>
              <div>
                <h3
                  className="text-2xl md:text-3xl font-light mb-2 tracking-[-0.01em]"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {seg.headline}
                </h3>
                <p className="text-[var(--stone)]/60 leading-relaxed max-w-[600px]">
                  {seg.desc}
                </p>
              </div>
            </div>
          </div>

          {/* Use case cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {seg.cases.map((c, i) => (
              <div
                key={c.ask}
                className="group bg-white border border-[var(--pebble)] rounded-xl p-6 hover:border-[var(--sage)]/40 hover:shadow-md hover:shadow-[var(--sage)]/5 transition-all duration-200"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="flex items-start gap-4">
                  <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--sage)]/10 flex items-center justify-center text-[var(--moss)] group-hover:bg-[var(--sage)]/20 transition-colors">
                    <CaseIcon type={c.icon} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-base font-normal mb-2 leading-snug text-[var(--ink)]"
                      style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                    >
                      &ldquo;{c.ask}&rdquo;
                    </p>
                    <p className="text-sm text-[var(--ink)]/45 leading-relaxed">
                      {c.result}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
