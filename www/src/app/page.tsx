import { Fragment } from "react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { ArrowRightIcon, GithubIcon, ChevronDownIcon } from "lucide-react";
// import { MascotGuide } from "@/components/mascot";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#f5f0e8] text-[#191919]">
      {/* <MascotGuide /> */}
      <Nav />
      <Hero />
      <HowItFeels />
      <ThreeThings />
      <UseCases />
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
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#f5f0e8]/90 backdrop-blur-sm border-b border-[#d5cfc4]/50">
      <div className="mx-auto max-w-[1200px] px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Matrix OS" className="size-6 rounded-md" />
          <span className="tracking-[0.12em] text-[14px] font-medium text-[#191919] uppercase">
            Matrix OS
          </span>
        </a>

        <div className="hidden md:flex items-center gap-8">
          <a href="#how" className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors">
            How it works
          </a>
          <a href="#use-cases" className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors">
            Use cases
          </a>
          <a href="/technical" className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors">
            Technical
          </a>
          <a href="/docs" className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors">
            Docs
          </a>
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors"
          >
            GitHub
          </a>
        </div>

        <div className="flex items-center gap-3">
          <SignedOut>
            <a
              href="/signup"
              className="inline-flex items-center gap-1.5 bg-[#191919] text-[#f5f0e8] text-sm px-4 py-2 rounded-full hover:bg-[#333] transition-colors"
            >
              Join the waitlist
              <ChevronDownIcon className="size-3.5" />
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="/dashboard"
              className="inline-flex items-center gap-1.5 bg-[#191919] text-[#f5f0e8] text-sm px-4 py-2 rounded-full hover:bg-[#333] transition-colors"
            >
              Dashboard
              <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedIn>
        </div>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── Hero ─────────────────────────────── */

function Hero() {
  return (
    <section id="hero" className="pt-32 md:pt-44 pb-20 px-6">
      <div className="mx-auto max-w-[900px] text-center">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-6 font-medium">
          Your home for personal software
        </p>
        <h1
          className="text-4xl sm:text-5xl md:text-[64px] font-bold leading-[1.1] tracking-[-0.02em] mb-8"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Describe what you need.
          <br />
          <span className="italic">Watch it appear.</span>
        </h1>
        <p className="text-lg md:text-xl text-[#191919]/60 leading-relaxed max-w-[600px] mx-auto mb-10">
          Matrix OS is a personal AI that builds software for you, remembers
          everything about you, and works across all your devices. No coding
          needed. You own everything. Now in early access.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap">
          <SignedOut>
            <a
              href="/signup"
              className="inline-flex items-center gap-2 bg-[#191919] text-[#f5f0e8] text-base px-7 py-3 rounded-full hover:bg-[#333] transition-colors font-medium"
            >
              Join the waitlist
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="/dashboard"
              className="inline-flex items-center gap-2 bg-[#191919] text-[#f5f0e8] text-base px-7 py-3 rounded-full hover:bg-[#333] transition-colors font-medium"
            >
              Go to Dashboard
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedIn>
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-base text-[#191919]/60 hover:text-[#191919] transition-colors"
          >
            <GithubIcon className="size-4" />
            Open source
          </a>
        </div>

        <div className="mt-16 mx-auto max-w-[1100px]">
          <div className="rounded-xl overflow-hidden shadow-2xl shadow-[#191919]/15 border border-[#d5cfc4]">
            <picture>
              <source srcSet="/images/screenshot-desktop.webp" type="image/webp" />
              <img
                src="/images/screenshot-desktop.png"
                alt="Matrix OS desktop showing a budget tracker and gym tracker app running side by side"
                className="w-full h-auto"
                loading="eager"
              />
            </picture>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── How It Feels ────────────────────────── */

function HowItFeels() {
  return (
    <section id="how" className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <div className="rounded-2xl bg-[#e5dfd4] p-8 sm:p-12 md:p-16">
          <div className="max-w-[700px] mx-auto">
            <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-6 font-medium">
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
                    <span className="shrink-0 text-xs font-mono text-[#191919]/30 pt-1 w-8">you</span>
                    <p
                      className="text-xl md:text-2xl font-bold tracking-[-0.01em] leading-snug"
                      style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                    >
                      {convo.you}
                    </p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="shrink-0 text-xs font-mono text-[#191919]/30 pt-1 w-8">os</span>
                    <p className="text-base md:text-lg text-[#191919]/60 leading-relaxed">
                      {convo.os}
                    </p>
                  </div>
                  {i < 2 && <div className="border-b border-[#191919]/8 pt-2" />}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────── Three Things ───────────────────────────── */

function ThreeThings() {
  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          What makes it different
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Three things your current tools{" "}
          <span className="italic">can&apos;t</span> do
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[#d5cfc4] border border-[#d5cfc4] rounded-xl overflow-hidden">
          {[
            {
              title: "It remembers you",
              desc: "Your AI has a persistent memory. It knows your projects, your preferences, how you like to work. You never re-explain yourself. It gets better the longer you use it.",
              detail: "Not a chat history. A real understanding of who you are.",
            },
            {
              title: "It builds software",
              desc: "Say what you need in plain English. A budget tracker, a study timer, a deploy monitor. Real software appears on your desktop in seconds. Not a template. Built for you.",
              detail: "Every app is a file you own. No app store, no subscription.",
            },
            {
              title: "It works everywhere",
              desc: "Same AI on your laptop, your phone, Telegram, WhatsApp, Discord, Slack. One conversation that continues across every device. No setup, no syncing, no switching.",
              detail: "Message it from anywhere. It's always the same AI.",
            },
          ].map((item) => (
            <div key={item.title} className="bg-[#f5f0e8] p-8 md:p-10">
              <h3
                className="text-xl font-bold mb-4 tracking-[-0.01em]"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                {item.title}
              </h3>
              <p className="text-[#191919]/60 leading-relaxed mb-4">
                {item.desc}
              </p>
              <p className="text-sm text-[#191919]/40 italic">
                {item.detail}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── Use Cases ──────────────────────────── */

function UseCases() {
  const cases = [
    {
      ask: "Build me a meal planner that knows my macros",
      result: "A personalized meal planning app, saved as a file, using your dietary data",
    },
    {
      ask: "Watch my GitHub deploys and text me if anything fails",
      result: "A monitoring agent that checks every 5 minutes and messages you on Telegram",
    },
    {
      ask: "Make a bedtime story generator for my kids",
      result: "A story app that knows your children's names, favorite characters, and age level",
    },
    {
      ask: "Track my freelance invoices and remind me about overdue ones",
      result: "An invoice tracker with automated weekly reminders on WhatsApp",
    },
    {
      ask: "Summarize my emails every morning and put it in Slack",
      result: "A daily briefing that runs at 8am, reads your inbox, and posts a summary",
    },
    {
      ask: "Build a workout log that learns what I like",
      result: "A fitness tracker that adapts exercises based on your history and preferences",
    },
  ];

  return (
    <section id="use-cases" className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          Home-cooked software
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr] gap-12 items-start mb-16">
          <h2
            className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Software made{" "}
            <span className="italic">just for you</span>
          </h2>
          <p className="text-[#191919]/60 leading-relaxed md:pt-2">
            Like a home-cooked meal instead of takeout. You describe exactly
            what you want, and your AI builds it. Not a template. Not an app
            store download. Software that fits your life perfectly.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-px bg-[#d5cfc4] border border-[#d5cfc4] rounded-xl overflow-hidden">
          {cases.map((c) => (
            <div key={c.ask} className="bg-[#f5f0e8] p-6">
              <p
                className="text-base font-bold mb-3 leading-snug"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                &ldquo;{c.ask}&rdquo;
              </p>
              <p className="text-sm text-[#191919]/50 leading-relaxed">
                {c.result}
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
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <div className="rounded-2xl bg-[#e5dfd4] p-8 sm:p-12 md:p-16 text-center">
          <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-6 font-medium">
            One AI, everywhere
          </p>
          <h2
            className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-6"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Message it from <span className="italic">anywhere</span>
          </h2>
          <p className="text-lg text-[#191919]/60 leading-relaxed max-w-[600px] mx-auto mb-12">
            Your AI lives on every platform you already use. Same memory,
            same personality, same capabilities. Start a conversation on your
            laptop, continue it from your phone.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4">
            {["Web Desktop", "Telegram", "WhatsApp", "Discord", "Slack", "Voice"].map((ch) => (
              <span
                key={ch}
                className="text-sm font-medium px-5 py-2.5 rounded-full border border-[#191919]/10 bg-[#f5f0e8]/60 text-[#191919]/70"
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
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          Not another AI chatbot
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          You own <span className="italic">everything</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-16">
          <div className="space-y-8">
            {[
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
            ].map((item) => (
              <div key={item.q}>
                <h3
                  className="text-lg font-bold mb-2"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {item.q}
                </h3>
                <p className="text-[#191919]/60 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>

          <div className="space-y-8">
            {[
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
            ].map((item) => (
              <div key={item.q}>
                <h3
                  className="text-lg font-bold mb-2"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {item.q}
                </h3>
                <p className="text-[#191919]/60 leading-relaxed">{item.a}</p>
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
          className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] mb-6 leading-tight"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Your AI.{" "}
          <span className="italic">Your software.</span>
          <br />
          Your rules.
        </h2>
        <p className="text-lg text-[#191919]/60 leading-relaxed max-w-[500px] mx-auto mb-10">
          Join the waitlist for early access to your personal instance at{" "}
          <span className="font-mono text-[#191919]">you.matrix-os.com</span>.
          We&apos;re letting people in gradually.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap mb-16">
          <SignedOut>
            <a
              href="/signup"
              className="inline-flex items-center gap-2 bg-[#191919] text-[#f5f0e8] text-base px-7 py-3 rounded-full hover:bg-[#333] transition-colors font-medium"
            >
              Join the waitlist
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedOut>
          <SignedIn>
            <a
              href="/dashboard"
              className="inline-flex items-center gap-2 bg-[#191919] text-[#f5f0e8] text-base px-7 py-3 rounded-full hover:bg-[#333] transition-colors font-medium"
            >
              Go to Dashboard
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedIn>
          <a
            href="/whitepaper"
            className="inline-flex items-center gap-2 text-base font-medium text-[#191919]/60 hover:text-[#191919] transition-colors border-b border-[#191919]/20 pb-0.5 hover:border-[#191919]/40"
          >
            Read the whitepaper
            <ArrowRightIcon className="size-4" />
          </a>
        </div>

        <blockquote className="max-w-[500px] mx-auto border-l-2 border-[#191919]/10 pl-6 text-left">
          <p
            className="text-base text-[#191919]/50 italic leading-relaxed"
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
    <footer className="py-16 px-6 border-t border-[#d5cfc4]">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Matrix OS" className="size-5 rounded" />
            <span className="text-sm text-[#191919]/50 font-mono">matrix-os.com</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-[#191919]/50">
            <a
              href="https://discord.gg/cSBBQWtPwV"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#191919] transition-colors"
            >
              Discord
            </a>
            <a
              href="https://x.com/joinmatrixos"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#191919] transition-colors"
            >
              X / Twitter
            </a>
            <a
              href="https://github.com/HamedMP/matrix-os"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#191919] transition-colors"
            >
              GitHub
            </a>
            <a href="/docs" className="hover:text-[#191919] transition-colors">
              Docs
            </a>
            <a href="/whitepaper" className="hover:text-[#191919] transition-colors">
              Whitepaper
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
