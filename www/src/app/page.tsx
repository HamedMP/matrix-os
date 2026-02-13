import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ArrowRightIcon,
  GithubIcon,
  SendIcon,
  TerminalIcon,
  LayersIcon,
  ShieldIcon,
} from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <Nav />
      <Hero />
      <TechStrip />
      <HowItWorks />
      <BentoFeatures />
      <Web4 />
      <CTA />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────── Nav ─────────────────────────────── */

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl flex items-center justify-between px-6 py-3.5">
        <a href="/" className="flex items-center gap-2 group">
          <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-xs font-bold text-white font-mono">M</span>
          </div>
          <span className="font-mono text-sm font-semibold tracking-tight text-foreground">
            matrix-os
          </span>
        </a>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <a href="#how-it-works">How It Works</a>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href="#features">Features</a>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a
              href="https://github.com/HamedMP/matrix-os"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GithubIcon className="size-4" />
            </a>
          </Button>
          <div className="w-px h-5 bg-border mx-2" />
          <Button size="sm" asChild>
            <a href="#get-started">
              Get Started
              <ArrowRightIcon />
            </a>
          </Button>
        </div>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── Hero ─────────────────────────────── */

function Hero() {
  return (
    <section className="relative pt-28 pb-8 px-6 overflow-hidden">
      {/* Decorative glow */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] animate-pulse-glow pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(194,112,58,0.12) 0%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto max-w-5xl">
        {/* Text block */}
        <div className="text-center mb-14">
          <div className="animate-fade-up">
            <Badge
              variant="outline"
              className="mb-8 border-primary/30 bg-card/80 text-primary font-mono text-xs tracking-widest uppercase backdrop-blur-sm"
            >
              Anthropic Hackathon -- Built with Opus 4.6
            </Badge>
          </div>

          <h1 className="animate-fade-up delay-100 text-5xl sm:text-6xl md:text-7xl lg:text-[5.5rem] font-bold tracking-tight mb-6 leading-[1.05]">
            The operating system
            <br />
            <span className="text-primary">that builds itself</span>
          </h1>

          <p className="animate-fade-up delay-200 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed font-light">
            Describe what you need. Matrix OS writes it into existence --
            real software, generated in real time, saved as files you own.
            The AI isn't a feature. It is the kernel.
          </p>

          <div className="animate-fade-up delay-300 flex items-center justify-center gap-4">
            <Button size="lg" className="h-12 px-8 text-base" asChild>
              <a href="#get-started">
                Get your instance
                <ArrowRightIcon />
              </a>
            </Button>
            <Button variant="outline" size="lg" className="h-12 px-8 text-base bg-card/60 backdrop-blur-sm" asChild>
              <a
                href="https://github.com/HamedMP/matrix-os"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon />
                View source
              </a>
            </Button>
          </div>
        </div>

        {/* OS Mockup */}
        <div className="animate-fade-up delay-500 relative mx-auto max-w-4xl">
          <OsMockup />
          {/* Shadow beneath mockup */}
          <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-3/4 h-16 bg-foreground/5 rounded-[100%] blur-2xl" />
        </div>
      </div>
    </section>
  );
}

function OsMockup() {
  return (
    <div className="rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/50">
        <div className="flex items-center gap-1.5">
          <div className="size-3 rounded-full bg-[#ff5f57]" />
          <div className="size-3 rounded-full bg-[#febc2e]" />
          <div className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 text-center">
          <span className="text-xs text-muted-foreground font-medium">
            Matrix OS
          </span>
        </div>
        <div className="w-[52px]" />
      </div>

      {/* Desktop area */}
      <div className="relative bg-background p-4 min-h-[340px] sm:min-h-[400px]">
        {/* Dock - left side */}
        <div className="absolute left-3 top-3 bottom-14 w-11 flex flex-col items-center gap-2 py-2 rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm">
          {["E", "N", "D"].map((letter, i) => (
            <div
              key={letter}
              className="size-8 rounded-lg bg-card border border-border/60 flex items-center justify-center text-xs font-semibold text-foreground shadow-sm"
            >
              {letter}
            </div>
          ))}
        </div>

        {/* App window */}
        <div className="ml-14 mr-0 sm:mr-4">
          <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden max-w-lg">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
              <div className="flex items-center gap-1">
                <div className="size-2 rounded-full bg-[#ff5f57]" />
                <div className="size-2 rounded-full bg-[#febc2e]" />
                <div className="size-2 rounded-full bg-[#28c840]" />
              </div>
              <span className="text-[10px] text-muted-foreground font-medium ml-2">
                expense-tracker
              </span>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Expenses</span>
                <span className="text-xs text-primary font-mono">$1,247.50</span>
              </div>
              {[
                { name: "Groceries", amount: "$89.20", cat: "Food" },
                { name: "AWS hosting", amount: "$42.00", cat: "Tech" },
                { name: "Coffee beans", amount: "$24.50", cat: "Food" },
              ].map((item) => (
                <div
                  key={item.name}
                  className="flex items-center justify-between py-2 border-b border-border/50 last:border-0"
                >
                  <div>
                    <span className="text-xs font-medium">{item.name}</span>
                    <span className="text-[10px] text-muted-foreground ml-2">
                      {item.cat}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">
                    {item.amount}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Conversation bubbles - right side, floating */}
        <div className="hidden sm:flex flex-col gap-2 absolute right-4 top-4 w-52 animate-slide-in-right delay-700">
          <div className="rounded-xl rounded-br-sm border border-border bg-card px-3 py-2 shadow-sm">
            <p className="text-[11px] text-foreground leading-relaxed">
              Build me an expense tracker with categories
            </p>
          </div>
          <div className="rounded-xl rounded-bl-sm border border-primary/20 bg-primary/5 px-3 py-2 shadow-sm self-start">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Creating expense-tracker.html with category filtering...
            </p>
            <div className="flex gap-1 mt-1.5">
              <span className="inline-block size-1 rounded-full bg-primary/60 animate-pulse" />
              <span className="inline-block size-1 rounded-full bg-primary/60 animate-pulse delay-200" style={{ animationDelay: "200ms" }} />
              <span className="inline-block size-1 rounded-full bg-primary/60 animate-pulse delay-400" style={{ animationDelay: "400ms" }} />
            </div>
          </div>
        </div>

        {/* Input bar */}
        <div className="absolute bottom-3 left-14 right-3">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card/90 px-3 py-2 shadow-lg backdrop-blur-sm max-w-md mx-auto">
            <span className="text-xs text-muted-foreground flex-1 truncate">
              Ask Matrix OS...
            </span>
            <div className="size-6 rounded-md bg-primary flex items-center justify-center shrink-0">
              <SendIcon className="size-3 text-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── Tech Strip ──────────────────────────── */

function TechStrip() {
  const items = [
    "Claude Opus 4.6",
    "Agent SDK",
    "Next.js 16",
    "Matrix Protocol",
    "200 Tests",
    "TypeScript",
  ];

  return (
    <section className="py-10 px-6">
      <div className="mx-auto max-w-4xl flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {items.map((item) => (
          <span
            key={item}
            className="text-xs font-mono tracking-wide text-muted-foreground/70 uppercase"
          >
            {item}
          </span>
        ))}
      </div>
    </section>
  );
}

/* ──────────────────────────── How It Works ─────────────────────────── */

function HowItWorks() {
  const steps = [
    {
      num: "01",
      title: "You describe it",
      desc: "Tell the OS what you need in natural language. A task tracker, an expense app, a dashboard -- anything.",
      visual: (
        <div className="font-mono text-xs space-y-1.5 text-muted-foreground">
          <div className="text-foreground">
            <span className="text-primary">$</span> Build me a notes app with
            markdown support
          </div>
        </div>
      ),
    },
    {
      num: "02",
      title: "The kernel writes it",
      desc: "Claude Opus 4.6 generates real software -- HTML, CSS, JS -- and saves it as a file on your system.",
      visual: (
        <div className="font-mono text-xs space-y-1 text-muted-foreground">
          <div>
            <span className="text-primary">writing</span> ~/apps/notes.html
          </div>
          <div>
            <span className="text-primary">writing</span> ~/data/notes/store.json
          </div>
          <div className="text-success">done in 4.2s</div>
        </div>
      ),
    },
    {
      num: "03",
      title: "It appears on your desktop",
      desc: "The shell detects the new file and renders it instantly. No build step. No deploy. Real-time software.",
      visual: (
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-card border border-border shadow-sm flex items-center justify-center text-xs font-semibold">
            N
          </div>
          <div>
            <div className="text-xs font-medium">notes</div>
            <div className="text-[10px] text-muted-foreground">~/apps/notes.html</div>
          </div>
        </div>
      ),
    },
  ];

  return (
    <section id="how-it-works" className="py-24 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-16">
          <Badge
            variant="outline"
            className="mb-4 border-primary/30 bg-card/80 text-primary font-mono text-xs tracking-widest uppercase"
          >
            How it works
          </Badge>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            From conversation to software
            <br />
            <span className="text-primary">in seconds</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {steps.map((step, i) => (
            <div key={step.num} className="relative group">
              {/* Connector line */}
              {i < steps.length - 1 && (
                <div className="hidden md:block absolute top-10 -right-3 w-6 border-t border-dashed border-border" />
              )}
              <div className="rounded-2xl border border-border bg-card p-6 h-full hover:shadow-lg hover:border-primary/20 transition-all duration-300">
                <div className="text-4xl font-bold text-primary/15 font-mono mb-4 select-none">
                  {step.num}
                </div>
                <h3 className="text-lg font-semibold mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                  {step.desc}
                </p>
                <div className="rounded-xl bg-secondary/70 border border-border/50 p-3">
                  {step.visual}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── Bento Features ──────────────────────── */

function BentoFeatures() {
  return (
    <section id="features" className="py-24 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-16">
          <Badge
            variant="outline"
            className="mb-4 border-primary/30 bg-card/80 text-primary font-mono text-xs tracking-widest uppercase"
          >
            Capabilities
          </Badge>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Not just an assistant.
            <br />
            <span className="text-primary">An operating system.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
          {/* Large: Everything Is a File */}
          <div className="md:col-span-4 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold mb-1">
                  Everything is a file
                </h3>
                <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
                  Apps, profiles, config, AI personality -- all stored as real
                  files. Back up your OS by copying a folder. Share an app by
                  sending a file.
                </p>
              </div>
            </div>
            <div className="rounded-xl bg-secondary/70 border border-border/50 p-4 font-mono text-xs text-muted-foreground">
              <div className="flex items-center gap-2 mb-2">
                <TerminalIcon className="size-3.5 text-primary" />
                <span className="text-primary text-[10px] uppercase tracking-wider font-semibold">
                  ~/matrixos/
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-1 gap-x-4">
                {[
                  "apps/expense-tracker.html",
                  "apps/notes.html",
                  "data/expenses/items.json",
                  "data/notes/store.json",
                  "system/theme.json",
                  "system/soul.md",
                  "system/config.json",
                  "agents/builder.md",
                ].map((f) => (
                  <div key={f} className="truncate">
                    {f}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Small: Self-Healing */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300 flex flex-col">
            <div className="size-10 rounded-xl bg-success/10 border border-success/20 flex items-center justify-center mb-4">
              <ShieldIcon className="size-5 text-success" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Self-healing</h3>
            <p className="text-sm text-muted-foreground leading-relaxed flex-1">
              Break something? The healer agent detects, diagnoses, and repairs
              it. Git-backed snapshots mean nothing is ever truly lost.
            </p>
            <div className="mt-4 rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              <span className="text-success">healer</span> restored notes.html
              from backup
            </div>
          </div>

          {/* Small: Multi-Channel */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <h3 className="text-lg font-semibold mb-1">Multi-channel</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              Same kernel, every platform. Web desktop, Telegram, WhatsApp,
              Discord, Slack -- all connected to one identity.
            </p>
            <div className="flex flex-wrap gap-2">
              {["Web", "Telegram", "WhatsApp", "Discord", "Slack"].map((ch) => (
                <span
                  key={ch}
                  className="text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-full border border-border bg-secondary/50 text-muted-foreground"
                >
                  {ch}
                </span>
              ))}
            </div>
          </div>

          {/* Small: SOUL */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <h3 className="text-lg font-semibold mb-1">SOUL identity</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              Define your AI's personality, values, and communication style
              in a single file. It shapes everything.
            </p>
            <div className="rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
              <div>
                <span className="text-primary">name:</span> Atlas
              </div>
              <div>
                <span className="text-primary">tone:</span> warm, direct
              </div>
              <div>
                <span className="text-primary">style:</span> concise
              </div>
            </div>
          </div>

          {/* Large: Self-Expanding + Architecture */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <h3 className="text-lg font-semibold mb-1">Self-expanding</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              The OS writes its own agents, skills, and tools. It grows
              new capabilities on demand.
            </p>
            <div className="rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
              <div>
                <span className="text-primary">+</span> agents/weather-skill.md
              </div>
              <div>
                <span className="text-primary">+</span> agents/deploy-tool.md
              </div>
              <div className="text-success">2 new skills registered</div>
            </div>
          </div>

          {/* Architecture metaphor card */}
          <div className="md:col-span-4 rounded-2xl border border-border bg-card overflow-hidden hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="px-6 pt-6 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <LayersIcon className="size-4 text-primary" />
                <h3 className="text-lg font-semibold">The core metaphor</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Claude Agent SDK mapped to real computer architecture
              </p>
            </div>
            <div className="grid grid-cols-2 text-xs font-mono border-t border-border">
              {[
                ["CPU", "Claude Opus 4.6"],
                ["RAM", "Context window"],
                ["Kernel", "Main agent + tools"],
                ["Processes", "Sub-agents"],
                ["Disk", "~/apps, ~/data, ~/system"],
                ["Syscalls", "Read, Write, Edit, Bash"],
                ["Drivers", "MCP servers"],
                ["IPC", "File coordination"],
              ].map(([left, right], i) => (
                <Fragment key={left}>
                  <div className="px-4 py-2.5 border-r border-border text-muted-foreground border-b border-b-border/50">
                    {left}
                  </div>
                  <div className="px-4 py-2.5 text-foreground border-b border-b-border/50">
                    {right}
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────────── Web 4 ──────────────────────────── */

function Web4() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="rounded-3xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden">
          <div className="p-8 sm:p-12 md:p-16 text-center">
            <Badge
              variant="outline"
              className="mb-6 border-primary/30 bg-primary/10 text-primary font-mono text-xs tracking-widest uppercase"
            >
              The Vision
            </Badge>

            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-6 leading-tight">
              This is <span className="text-primary">Web 4</span>
            </h2>

            <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-12 leading-relaxed">
              Your operating system, messaging, social media, AI assistant, apps,
              games, and identity -- all one thing.
              Not stitched together with APIs. Actually one thing.
            </p>

            {/* Timeline */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-0 mb-14">
              {[
                { era: "1970s", label: "Terminal" },
                { era: "1980s", label: "OS" },
                { era: "1990s", label: "GUI" },
                { era: "2000s", label: "Web" },
                { era: "2020s", label: "AI" },
                { era: "2026", label: "Matrix OS", active: true },
              ].map((item, i) => (
                <Fragment key={item.era}>
                  {i > 0 && (
                    <div className="hidden sm:block w-8 md:w-12 border-t border-dashed border-border" />
                  )}
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className={`size-10 rounded-full flex items-center justify-center border-2 transition-colors ${
                        item.active
                          ? "border-primary bg-primary text-white shadow-lg shadow-primary/20"
                          : "border-border bg-card text-muted-foreground"
                      }`}
                    >
                      <span className="text-[10px] font-mono font-bold">
                        {item.era.slice(2)}
                      </span>
                    </div>
                    <span
                      className={`text-xs font-medium ${
                        item.active ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {item.label}
                    </span>
                  </div>
                </Fragment>
              ))}
            </div>

            {/* Three pillars */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
              {[
                {
                  tag: "@you:matrix-os.com",
                  title: "Federated identity",
                  desc: "Matrix protocol IDs. One handle, everywhere. Your AI has its own identity too.",
                },
                {
                  tag: "AI-to-AI",
                  title: "Agents talk to agents",
                  desc: "Your AI negotiates with other AIs via encrypted Matrix rooms. No human in the loop.",
                },
                {
                  tag: "git sync",
                  title: "Every device is a peer",
                  desc: "Laptop, phone, cloud -- all equal. Git is the sync fabric. No central server.",
                },
              ].map((item) => (
                <div
                  key={item.tag}
                  className="rounded-xl border border-border bg-background/50 p-5"
                >
                  <span className="inline-block font-mono text-[10px] tracking-wider uppercase text-primary bg-primary/10 px-2 py-0.5 rounded-md mb-3">
                    {item.tag}
                  </span>
                  <h3 className="text-base font-semibold mb-1">
                    {item.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────── CTA ───────────────────────────── */

function CTA() {
  return (
    <section id="get-started" className="py-24 px-6">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
          Get your own <span className="text-primary">Matrix OS</span>
        </h2>
        <p className="text-muted-foreground mb-10 leading-relaxed max-w-lg mx-auto">
          Sign up to receive your personal instance at
          <span className="font-mono text-foreground"> you.matrix-os.com</span>.
          Build apps, connect channels, customize your AI.
        </p>

        <div className="rounded-2xl border border-border bg-card p-8 shadow-lg max-w-md mx-auto">
          <form className="space-y-3">
            <Input
              type="email"
              placeholder="you@example.com"
              className="h-12 bg-background text-base"
            />
            <Button type="submit" className="w-full h-12 text-base">
              <SendIcon />
              Join the waitlist
            </Button>
          </form>
          <p className="text-[11px] text-muted-foreground mt-4">
            Built for the{" "}
            <a
              href="https://cv.inc/e/claude-code-hackathon"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Anthropic Hackathon
            </a>
            . The entire system -- kernel, shell, this page -- is built with
            Claude Code.
          </p>
        </div>

        <blockquote className="mt-12 max-w-xl mx-auto border-l-2 border-primary/30 pl-6 text-left">
          <p className="text-sm text-muted-foreground italic leading-relaxed">
            "This is Matrix OS. It's not just an AI assistant and it's not just
            an operating system. It's both. And it's also your social network,
            your messaging platform, and your game console. One identity. One
            platform. Every device. This is Web 4."
          </p>
        </blockquote>
      </div>
    </section>
  );
}

/* ─────────────────────────────── Footer ──────────────────────────── */

function Footer() {
  return (
    <footer className="py-10 px-6 border-t border-border/60">
      <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="size-5 rounded bg-primary flex items-center justify-center">
            <span className="text-[8px] font-bold text-white font-mono">M</span>
          </div>
          <span className="font-mono text-xs text-muted-foreground">
            matrix-os.com
          </span>
        </div>
        <div className="flex items-center gap-6 text-xs text-muted-foreground">
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://spec.matrix.org/latest/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            Matrix Protocol
          </a>
          <a
            href="https://cv.inc/e/claude-code-hackathon"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            Hackathon
          </a>
        </div>
        <span className="text-[10px] text-muted-foreground/60">
          Built with Claude Opus 4.6
        </span>
      </div>
    </footer>
  );
}
