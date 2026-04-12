import { SignedIn, SignedOut } from "@clerk/nextjs";
import { ArrowRightIcon, GithubIcon } from "lucide-react";
import { UseCasesTabs } from "@/components/landing/UseCasesTabs";

const faqItems = [
  {
    q: "What happens to my data?",
    a: "Everything is a file on your system. Apps, data, settings, your AI's memory. Copy a folder to back up your entire OS. No vendor lock-in. No opaque databases.",
  },
  {
    q: "Do I need to code?",
    a: "No. You describe what you want in plain English. The AI writes the code, saves it as a file, and it appears on your desktop. You never touch a line of code unless you want to.",
  },
  {
    q: "What if something breaks?",
    a: "The OS heals itself. A built-in agent monitors for problems and fixes them automatically. Everything is versioned with git, so nothing is ever truly lost.",
  },
  {
    q: "Is it private?",
    a: "You can self-host it on your own server. Your data never leaves your machine unless you want it to. Open source, MIT licensed, auditable by anyone.",
  },
  {
    q: "How is this different from ChatGPT?",
    a: "ChatGPT is a chat window that forgets you. Matrix OS is an operating system that remembers you, builds software for you, runs on every device, and works while you sleep.",
  },
  {
    q: "What does it cost?",
    a: "Free to start. The platform is open source. You bring your own AI key, or use our hosted instances. No surprise bills, no credit-burning loops.",
  },
];

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "Matrix OS",
      url: "https://matrix-os.com",
      logo: "https://matrix-os.com/rabbit.svg",
      sameAs: [
        "https://github.com/HamedMP/matrix-os",
        "https://x.com/joinmatrixos",
        "https://discord.gg/cSBBQWtPwV",
      ],
    },
    {
      "@type": "SoftwareApplication",
      name: "Matrix OS",
      url: "https://matrix-os.com",
      applicationCategory: "OperatingSystem",
      operatingSystem: "Web, Docker",
      description:
        "An AI-native operating system that generates software from conversation. Describe what you need and watch it appear on your desktop.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
    {
      "@type": "FAQPage",
      mainEntity: faqItems.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.a,
        },
      })),
    },
  ],
});

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[var(--stone)] text-[var(--ink)]">
      {/* JSON-LD: static content only, no user input -- safe to inline */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <Nav />
      <Hero />
      <ProofBar />
      <HowItFeels />
      <ThreeThings />
      <UseCasesTabs />
      <Channels />
      <WhyDifferent />
      <CTA />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────── Nav ─────────────────────────────── */

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[var(--stone)]/90 backdrop-blur-sm border-b border-[var(--pebble)]/50">
      <div className="mx-auto max-w-[1200px] px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5">
          <img src="/rabbit.svg" alt="Matrix OS" className="size-5" />
          <span className="tracking-[0.12em] text-[14px] font-semibold text-[var(--ink)] uppercase">
            Matrix OS
          </span>
        </a>

        <div className="hidden md:flex items-center gap-8">
          <a href="#how" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">
            How it works
          </a>
          <a href="#use-cases" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">
            Use cases
          </a>
          <a href="/technical" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">
            Technical
          </a>
          <a href="/docs" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">
            Docs
          </a>
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors"
          >
            GitHub
          </a>
        </div>

        <div className="flex items-center gap-3">
          <SignedOut>
            <a
              href="https://app.matrix-os.com"
              className="inline-flex items-center gap-1.5 bg-[var(--forest)] text-[var(--stone)] text-sm px-4 py-2 rounded-full hover:bg-[var(--ink)] transition-colors"
            >
              Join the waitlist
              <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="https://app.matrix-os.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 bg-[var(--forest)] text-[var(--stone)] text-sm px-4 py-2 rounded-full hover:bg-[var(--ink)] transition-colors"
            >
              Open Matrix OS
              <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedIn>
        </div>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── Hero ─────────────────────────────── */

function BotanicalScatter() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {/* Bottom-left cluster */}
      <svg className="absolute -bottom-8 -left-12 w-[500px] h-[400px] opacity-80" viewBox="0 0 500 400" fill="none">
        <g fill="var(--forest)" opacity="0.7">
          <circle cx="45" cy="350" r="3" /><circle cx="60" cy="330" r="2" /><circle cx="30" cy="340" r="4" />
          <circle cx="80" cy="360" r="2.5" /><circle cx="100" cy="345" r="1.5" /><circle cx="55" cy="310" r="2" />
          <circle cx="120" cy="370" r="3" /><circle cx="140" cy="355" r="2" /><circle cx="90" cy="320" r="1.5" />
          <circle cx="70" cy="295" r="2.5" /><circle cx="110" cy="305" r="2" /><circle cx="35" cy="280" r="3" />
          <circle cx="150" cy="340" r="1.5" /><circle cx="170" cy="365" r="2.5" /><circle cx="130" cy="325" r="2" />
          <circle cx="50" cy="260" r="2" /><circle cx="85" cy="275" r="3" /><circle cx="25" cy="300" r="1.5" />
          <circle cx="160" cy="310" r="2" /><circle cx="190" cy="350" r="3" /><circle cx="200" cy="370" r="2" />
          <circle cx="40" cy="370" r="5" /><circle cx="65" cy="380" r="3" /><circle cx="95" cy="385" r="4" />
          <circle cx="15" cy="360" r="2.5" /><circle cx="125" cy="380" r="3.5" /><circle cx="155" cy="385" r="2" />
        </g>
        <g fill="var(--forest)" opacity="0.4">
          <circle cx="200" cy="330" r="1.5" /><circle cx="220" cy="355" r="2" /><circle cx="180" cy="290" r="1.5" />
          <circle cx="240" cy="370" r="1" /><circle cx="130" cy="280" r="1.5" /><circle cx="105" cy="260" r="1" />
          <circle cx="60" cy="245" r="1.5" /><circle cx="160" cy="270" r="1" /><circle cx="210" cy="310" r="1.5" />
          <circle cx="250" cy="350" r="1" /><circle cx="45" cy="230" r="1" /><circle cx="80" cy="240" r="1.5" />
        </g>
        <g fill="var(--forest)" opacity="0.6">
          <ellipse cx="50" cy="340" rx="8" ry="3" transform="rotate(-30 50 340)" />
          <ellipse cx="75" cy="365" rx="6" ry="2.5" transform="rotate(15 75 365)" />
          <ellipse cx="100" cy="375" rx="10" ry="3" transform="rotate(-45 100 375)" />
          <ellipse cx="30" cy="320" rx="7" ry="2.5" transform="rotate(20 30 320)" />
          <ellipse cx="120" cy="350" rx="5" ry="2" transform="rotate(-10 120 350)" />
          <ellipse cx="60" cy="290" rx="6" ry="2" transform="rotate(35 60 290)" />
          <ellipse cx="140" cy="370" rx="8" ry="2.5" transform="rotate(-25 140 370)" />
          <ellipse cx="40" cy="355" rx="9" ry="3" transform="rotate(40 40 355)" />
          <ellipse cx="90" cy="300" rx="5" ry="2" transform="rotate(-15 90 300)" />
          <ellipse cx="170" cy="360" rx="7" ry="2.5" transform="rotate(10 170 360)" />
        </g>
      </svg>

      {/* Right cluster */}
      <svg className="absolute -right-8 top-1/4 w-[350px] h-[500px] opacity-70" viewBox="0 0 350 500" fill="none">
        <g fill="var(--forest)" opacity="0.5">
          <circle cx="300" cy="100" r="2.5" /><circle cx="320" cy="130" r="3" /><circle cx="290" cy="80" r="2" />
          <circle cx="310" cy="160" r="1.5" /><circle cx="330" cy="110" r="2.5" /><circle cx="280" cy="140" r="2" />
          <circle cx="340" cy="180" r="3" /><circle cx="300" cy="200" r="2" /><circle cx="325" cy="220" r="2.5" />
          <circle cx="310" cy="250" r="1.5" /><circle cx="295" cy="170" r="2" /><circle cx="335" cy="150" r="1.5" />
          <circle cx="315" cy="280" r="2" /><circle cx="340" cy="260" r="3" /><circle cx="290" cy="230" r="1.5" />
          <circle cx="330" cy="300" r="2.5" /><circle cx="305" cy="320" r="2" /><circle cx="320" cy="340" r="1.5" />
        </g>
        <g fill="var(--forest)" opacity="0.3">
          <circle cx="270" cy="120" r="1.5" /><circle cx="260" cy="160" r="1" /><circle cx="275" cy="200" r="1.5" />
          <circle cx="250" cy="180" r="1" /><circle cx="285" cy="260" r="1" /><circle cx="265" cy="240" r="1.5" />
          <circle cx="270" cy="300" r="1" /><circle cx="250" cy="280" r="1" /><circle cx="290" cy="310" r="1.5" />
        </g>
        <g fill="var(--forest)" opacity="0.45">
          <ellipse cx="310" cy="120" rx="7" ry="2.5" transform="rotate(25 310 120)" />
          <ellipse cx="325" cy="170" rx="6" ry="2" transform="rotate(-20 325 170)" />
          <ellipse cx="300" cy="210" rx="8" ry="3" transform="rotate(40 300 210)" />
          <ellipse cx="335" cy="250" rx="5" ry="2" transform="rotate(-35 335 250)" />
          <ellipse cx="315" cy="290" rx="7" ry="2.5" transform="rotate(15 315 290)" />
          <ellipse cx="290" cy="150" rx="6" ry="2" transform="rotate(-10 290 150)" />
        </g>
      </svg>

      {/* Top-right sparse scatter */}
      <svg className="absolute -top-4 right-1/4 w-[300px] h-[200px] opacity-40" viewBox="0 0 300 200" fill="none">
        <g fill="var(--forest)">
          <circle cx="200" cy="40" r="1.5" /><circle cx="230" cy="60" r="2" /><circle cx="250" cy="30" r="1" />
          <circle cx="180" cy="70" r="1.5" /><circle cx="260" cy="80" r="2" /><circle cx="210" cy="50" r="1" />
          <circle cx="240" cy="100" r="1.5" /><circle cx="270" cy="55" r="1" />
          <ellipse cx="220" cy="45" rx="5" ry="2" transform="rotate(-20 220 45)" />
          <ellipse cx="255" cy="70" rx="4" ry="1.5" transform="rotate(30 255 70)" />
        </g>
      </svg>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 overflow-hidden">
      <BotanicalScatter />

      {/* Wordmark */}
      <p className="tracking-[0.15em] text-[14px] sm:text-[16px] font-semibold text-[var(--ink)] uppercase mb-16 relative z-10">
        Matrix OS
      </p>

      {/* Rabbit logo */}
      <div className="relative z-10 mb-16">
        <img
          src="/rabbit.svg"
          alt="Matrix OS logomark"
          className="w-24 h-20 sm:w-32 sm:h-[106px]"
        />
      </div>

      {/* Tagline */}
      <h1
        className="text-3xl sm:text-4xl md:text-5xl font-light leading-[1.15] tracking-[-0.01em] text-center max-w-[700px] relative z-10"
        style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
      >
        Your AI operating system
      </h1>

      <p className="mt-6 text-base md:text-lg text-[var(--ink)]/50 text-center max-w-[500px] leading-relaxed relative z-10">
        A personal AI that builds software for you, remembers
        everything, and works across every device you own.
        Open source. You keep every file.
      </p>

      <div className="mt-10 flex items-center gap-4 flex-wrap justify-center relative z-10">
        <SignedOut>
          <a
            href="https://app.matrix-os.com"
            className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-sm px-6 py-2.5 rounded-full hover:bg-[var(--ink)] transition-colors font-medium"
          >
            Get early access
            <ArrowRightIcon className="size-3.5" />
          </a>
        </SignedOut>
        <SignedIn>
          <a
            href="https://app.matrix-os.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-sm px-6 py-2.5 rounded-full hover:bg-[var(--ink)] transition-colors font-medium"
          >
            Open Matrix OS
            <ArrowRightIcon className="size-3.5" />
          </a>
        </SignedIn>
        <a
          href="https://github.com/HamedMP/matrix-os"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-[var(--ink)]/50 hover:text-[var(--ink)] transition-colors"
        >
          <GithubIcon className="size-4" />
          Open source
        </a>
      </div>

      {/* Scroll hint */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-[var(--ink)]/20">
        <div className="w-px h-8 bg-[var(--ink)]/15" />
      </div>
    </section>
  );
}

/* ─────────────────────────── Proof Bar ───────────────────────────── */

function ProofBar() {
  return (
    <section className="py-8 px-6">
      <div className="mx-auto max-w-[900px]">
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-[var(--ink)]/35 font-mono">
          <span>MIT licensed</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>Claude Opus 4.6</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>2,800+ tests</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>6 channels</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>Free to start</span>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── How It Feels ────────────────────────── */

function HowItFeels() {
  return (
    <section id="how" className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <div className="rounded-2xl bg-[var(--forest)] text-[var(--stone)] p-8 sm:p-12 md:p-16">
          <div className="max-w-[700px] mx-auto">
            <p className="text-sm tracking-[0.15em] uppercase text-[var(--sage)] mb-6 font-medium">
              How it works
            </p>
            <div className="space-y-12">
              {[
                {
                  you: "Build me an expense tracker with categories",
                  os: "Done. It's on your desktop. I saved it to ~/apps/expenses.html. Want me to add charts?",
                },
                {
                  you: "Remind me to call mom every Sunday at 10am",
                  os: "Set up. I'll message you on Telegram at 10am every Sunday. If you want, I can also text her that you're calling.",
                },
                {
                  you: "Why is my server slow today?",
                  os: "I checked your monitoring. CPU is at 92% from a runaway cron job. I paused it. Here's what happened.",
                },
              ].map((convo, i) => (
                <div key={i} className="space-y-4">
                  <div className="flex gap-3 items-start">
                    <span className="shrink-0 text-xs font-mono text-[var(--sage)]/60 pt-1 w-8">you</span>
                    <p
                      className="text-xl md:text-2xl font-light tracking-[-0.01em] leading-snug"
                      style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                    >
                      {convo.you}
                    </p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="shrink-0 text-xs font-mono text-[var(--sage)]/60 pt-1 w-8">os</span>
                    <p className="text-base md:text-lg text-[var(--stone)]/60 leading-relaxed">
                      {convo.os}
                    </p>
                  </div>
                  {i < 2 && <div className="border-b border-[var(--stone)]/10 pt-2" />}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-12 rounded-xl overflow-hidden shadow-2xl shadow-[var(--ink)]/10 border border-[var(--pebble)]">
          <picture>
            <source srcSet="/images/screenshot-desktop.webp" type="image/webp" />
            <img
              src="/images/screenshot-desktop.png"
              alt="Matrix OS desktop showing a budget tracker and gym tracker app running side by side"
              className="w-full h-auto"
              loading="lazy"
            />
          </picture>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────── Three Things ───────────────────────────── */

function ThreeThings() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">
          Not another chatbot
        </p>
        <h2
          className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          ChatGPT gives you answers.{" "}
          <span className="italic">This gives you software.</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[var(--pebble)] border border-[var(--pebble)] rounded-xl overflow-hidden">
          {[
            {
              num: "01",
              title: "Never re-explain yourself",
              desc: "Matrix OS remembers your projects, your preferences, your people. Ask it something on Monday and reference it on Friday. It knows the context.",
              detail: "Not a chat history. A growing understanding of who you are.",
            },
            {
              num: "02",
              title: "Software that didn't exist until you asked",
              desc: "Describe an expense tracker, a CRM, a bedtime story app. Working software appears on your desktop in seconds. Saved as a file you own. No app store. No subscription.",
              detail: "You asked. It built. You own it.",
            },
            {
              num: "03",
              title: "One AI across every device",
              desc: "Start a conversation on your laptop. Continue it from Telegram on the bus. Check in from WhatsApp at dinner. Same AI, same memory, same capabilities.",
              detail: "Six channels and counting. Your AI goes where you go.",
            },
          ].map((item) => (
            <div key={item.title} className="bg-[var(--stone)] p-8 md:p-10">
              <span className="text-xs font-mono text-[var(--moss)]/60 mb-3 block">{item.num}</span>
              <h3
                className="text-xl font-normal mb-4 tracking-[-0.01em]"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                {item.title}
              </h3>
              <p className="text-[var(--ink)]/55 leading-relaxed mb-4">
                {item.desc}
              </p>
              <p className="text-sm text-[var(--moss)] italic">
                {item.detail}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── Channels ───────────────────────────── */

function Channels() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <div className="rounded-2xl bg-gradient-to-br from-[var(--sage)]/10 to-[var(--moss)]/10 border border-[var(--sage)]/20 p-8 sm:p-12 md:p-16 text-center">
          <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-6 font-medium">
            One AI, everywhere
          </p>
          <h2
            className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em] mb-6"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Message it from <span className="italic">anywhere</span>
          </h2>
          <p className="text-lg text-[var(--ink)]/50 leading-relaxed max-w-[600px] mx-auto mb-12">
            Your AI lives on every platform you already use. Same memory,
            same personality, same capabilities. Start a conversation on your
            laptop, continue it from your phone.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            {["Web Desktop", "Telegram", "WhatsApp", "Discord", "Slack", "Voice"].map((ch) => (
              <span
                key={ch}
                className="text-sm font-medium px-5 py-2.5 rounded-full border border-[var(--moss)]/20 bg-[var(--stone)]/80 text-[var(--forest)]"
              >
                {ch}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────── Why Different ──────────────────────────── */

function WhyDifferent() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">
          Not another AI chatbot
        </p>
        <h2
          className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          You own <span className="italic">everything</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-16">
          <div className="space-y-8">
            {faqItems.slice(0, 3).map((item) => (
              <div key={item.q}>
                <h3
                  className="text-lg font-normal mb-2"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {item.q}
                </h3>
                <p className="text-[var(--ink)]/55 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>

          <div className="space-y-8">
            {faqItems.slice(3).map((item) => (
              <div key={item.q}>
                <h3
                  className="text-lg font-normal mb-2"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {item.q}
                </h3>
                <p className="text-[var(--ink)]/55 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────── CTA ───────────────────────────── */

function CTA() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[700px] text-center">
        <h2
          className="text-3xl sm:text-4xl md:text-5xl font-light tracking-[-0.01em] mb-6 leading-tight"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Your AI.{" "}
          <span className="italic">Your software.</span>
          <br />
          Your rules.
        </h2>
        <p className="text-lg text-[var(--ink)]/50 leading-relaxed max-w-[520px] mx-auto mb-3">
          Free to start. Open source. Bring your own AI key or
          use our hosted instances.
        </p>
        <p className="text-sm text-[var(--ink)]/35 mb-10">
          No credit card. No surprise bills. Cancel anytime.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap mb-16">
          <SignedOut>
            <a
              href="https://app.matrix-os.com"
              className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-base px-7 py-3 rounded-full hover:bg-[var(--ink)] transition-colors font-medium"
            >
              Get early access
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="https://app.matrix-os.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-base px-7 py-3 rounded-full hover:bg-[var(--ink)] transition-colors font-medium"
            >
              Go to Dashboard
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedIn>
          <a
            href="/whitepaper"
            className="inline-flex items-center gap-2 text-base font-medium text-[var(--ink)]/50 hover:text-[var(--ink)] transition-colors border-b border-[var(--ink)]/15 pb-0.5 hover:border-[var(--ink)]/30"
          >
            Read the whitepaper
            <ArrowRightIcon className="size-4" />
          </a>
        </div>

        <blockquote className="max-w-[500px] mx-auto border-l-2 border-[var(--sage)] pl-6 text-left">
          <p
            className="text-base text-[var(--ink)]/45 italic leading-relaxed"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            &ldquo;Like having a developer, a personal assistant, and a
            sysadmin who all know you by name, work 24/7, and never
            forget anything.&rdquo;
          </p>
        </blockquote>
      </div>
    </section>
  );
}

/* ─────────────────────────────── Footer ──────────────────────────── */

function Footer() {
  return (
    <footer className="py-16 px-6 border-t border-[var(--pebble)]">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div className="flex items-center gap-2.5">
            <img src="/rabbit.svg" alt="Matrix OS" className="size-4" />
            <span className="text-sm text-[var(--ink)]/40 font-mono">matrix-os.com</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-[var(--ink)]/40">
            <a
              href="https://discord.gg/cSBBQWtPwV"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--ink)] transition-colors"
            >
              Discord
            </a>
            <a
              href="https://x.com/joinmatrixos"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--ink)] transition-colors"
            >
              X / Twitter
            </a>
            <a
              href="https://github.com/HamedMP/matrix-os"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--ink)] transition-colors"
            >
              GitHub
            </a>
            <a href="/docs" className="hover:text-[var(--ink)] transition-colors">
              Docs
            </a>
            <a href="/whitepaper" className="hover:text-[var(--ink)] transition-colors">
              Whitepaper
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
