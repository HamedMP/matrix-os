import { Fragment } from "react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRightIcon,
  GithubIcon,
  SendIcon,
  TerminalIcon,
  LayersIcon,
  ShieldIcon,
  HammerIcon,
  SearchIcon,
  RocketIcon,
  HeartPulseIcon,
  SparklesIcon,
  BookOpenIcon,
  FileTextIcon,
  ZapIcon,
  MessageSquareIcon,
  BrainIcon,
  WrenchIcon,
  CheckIcon,
  MinusIcon,
  SmartphoneIcon,
  PuzzleIcon,
  MonitorIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <Nav />
      <Hero />
      <TechStrip />
      <Problem />
      <HowItWorks />
      <AgentShowcase />
      <BentoFeatures />
      <SkillsShowcase />
      <OpenClawBridge />
      <Web4 />
      <CTA />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────── Nav ─────────────────────────────── */

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50">
      <div className="mx-auto max-w-5xl px-4 pt-4">
        <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-card/60 backdrop-blur-xl px-5 py-2.5 shadow-sm">
          <a href="/" className="flex items-center gap-2.5 group">
            <img src="/logo.png" alt="Matrix OS" className="size-7 rounded-lg shadow-sm" />
            <span className="text-sm font-semibold tracking-tight text-foreground">
              Matrix OS
            </span>
          </a>

          <div className="hidden sm:flex items-center gap-0.5">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground text-xs" asChild>
              <a href="#how-it-works">How It Works</a>
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground text-xs" asChild>
              <a href="#features">Features</a>
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground text-xs" asChild>
              <a href="#vs-openclaw">vs OpenClaw</a>
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground text-xs" asChild>
              <a href="#web4">Web 4</a>
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground text-xs" asChild>
              <a href="/whitepaper">Whitepaper</a>
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" asChild>
              <a
                href="https://github.com/HamedMP/matrix-os"
                target="_blank"
                rel="noopener noreferrer"
                title="GitHub"
              >
                <GithubIcon className="size-4" />
              </a>
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" asChild>
              <a
                href="https://deepwiki.com/HamedMP/matrix-os/"
                target="_blank"
                rel="noopener noreferrer"
                title="DeepWiki"
              >
                <BookOpenIcon className="size-4" />
              </a>
            </Button>
            <SignedOut>
              <Button size="sm" className="rounded-xl text-xs px-4" asChild>
                <a href="#get-started">
                  Get Started
                </a>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button size="sm" className="rounded-xl text-xs px-4" asChild>
                <a href="/dashboard">
                  Dashboard
                  <ArrowRightIcon className="size-3 ml-1" />
                </a>
              </Button>
            </SignedIn>
          </div>
        </div>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── Hero ─────────────────────────────── */

function Hero() {
  return (
    <section className="relative pt-32 pb-20 px-6 overflow-hidden">
      {/* Decorative glow */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] animate-pulse-glow pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(194,112,58,0.1) 0%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto max-w-5xl">
        {/* Text block */}
        <div className="text-center mb-16">
          <div className="animate-fade-up">
            <Badge
              variant="outline"
              className="mb-6 border-primary/30 bg-card/80 text-primary font-mono text-[10px] tracking-[0.2em] uppercase backdrop-blur-sm py-1.5 px-4"
            >
              Built with Claude Opus 4.6
            </Badge>
          </div>

          <h1 className="animate-fade-up delay-100 text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-[1.1]">
            Your computer is stuck in 1984.
            <br />
            <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.15em]">This one isn't.</span>
          </h1>

          <p className="animate-fade-up delay-200 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto mb-10 leading-relaxed">
            Matrix OS is an AI operating system where software writes itself.
            Describe what you need. Watch it appear. Everything is a file you own.
          </p>

          <div className="animate-fade-up delay-300 flex items-center justify-center gap-3 flex-wrap">
            <SignedOut>
              <Button size="lg" className="h-11 px-7 text-sm rounded-xl" asChild>
                <a href="/signup">
                  Get your instance
                  <ArrowRightIcon className="size-4 ml-1" />
                </a>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button size="lg" className="h-11 px-7 text-sm rounded-xl" asChild>
                <a href="/dashboard">
                  Go to Dashboard
                  <ArrowRightIcon className="size-4 ml-1" />
                </a>
              </Button>
            </SignedIn>
            <Button variant="outline" size="lg" className="h-11 px-7 text-sm rounded-xl bg-card/60 backdrop-blur-sm" asChild>
              <a href="/whitepaper">
                <BookOpenIcon className="size-4" />
                Whitepaper
              </a>
            </Button>
            <Button variant="outline" size="lg" className="h-11 px-7 text-sm rounded-xl bg-card/60 backdrop-blur-sm" asChild>
              <a
                href="https://github.com/HamedMP/matrix-os"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon className="size-4" />
                Source
              </a>
            </Button>
          </div>
        </div>

        {/* OS Mockup */}
        <div className="animate-fade-up delay-500 relative mx-auto max-w-4xl">
          <OsMockup />
          {/* Shadow beneath mockup */}
          <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 w-3/4 h-20 bg-foreground/5 rounded-[100%] blur-3xl" />
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
    "926 Tests Passing",
    "26 IPC Tools",
    "20 Skills",
    "6 Agents",
    "Expo Mobile App",
    "Plugin System",
    "Claude Opus 4.6",
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

/* ──────────────────────────── Problem ──────────────────────────── */

function Problem() {
  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-8 leading-tight text-foreground/80">
          Thousands of apps that don't talk to each other.
          <br />
          An AI assistant trapped in a chat box.
          <br />
          Files scattered across services you don't control.
        </h2>
        <p className="text-lg text-muted-foreground leading-relaxed max-w-xl mx-auto">
          What if your OS understood you? What if software wrote itself?
          What if every device you own was the same computer?
        </p>
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
      desc: "Tell the OS what you need in natural language. A task tracker, an expense app, a dashboard. Anything.",
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
      desc: "Claude Opus 4.6 generates real software (HTML, CSS, JS) and saves it as a file on your system.",
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
            in <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.3em]">seconds</span>
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
                <div className="text-4xl font-bold text-primary/30 font-mono mb-4 select-none">
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

/* ──────────────────────────── Agent Showcase ─────────────────────── */

function AgentShowcase() {
  const agents = [
    {
      icon: HammerIcon,
      name: "Builder",
      role: "Creates apps and features from your descriptions",
      example: '"Build me an expense tracker" -> writes ~/apps/expenses.html',
    },
    {
      icon: SearchIcon,
      name: "Researcher",
      role: "Investigates problems, reads docs, gathers context",
      example: '"Why is my app slow?" -> analyzes code, suggests fixes',
    },
    {
      icon: RocketIcon,
      name: "Deployer",
      role: "Ships code to production, manages infrastructure",
      example: '"Deploy this to the cloud" -> provisions and deploys',
    },
    {
      icon: HeartPulseIcon,
      name: "Healer",
      role: "Detects failures and repairs the OS autonomously",
      example: "Corrupted file detected -> restored from git snapshot",
    },
    {
      icon: SparklesIcon,
      name: "Evolver",
      role: "Grows new capabilities, writes new agents and skills",
      example: '"I wish I could..." -> creates a new skill file',
    },
  ];

  return (
    <section id="agents" className="py-24 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-16">
          <Badge
            variant="outline"
            className="mb-4 border-primary/30 bg-card/80 text-primary font-mono text-xs tracking-widest uppercase"
          >
            Agent Team
          </Badge>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Five agents.{" "}
            <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.3em]">One kernel.</span>
          </h2>
          <p className="mt-4 text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Your request reaches the kernel. The kernel decides which agent handles it.
            Each agent has its own prompt, tools, and specialty.
          </p>
        </div>

        {/* Flow visualization */}
        <div className="mb-12 rounded-2xl border border-border bg-card p-6 overflow-x-auto">
          <div className="flex items-center justify-center gap-2 sm:gap-3 min-w-[500px] mx-auto font-mono text-xs">
            <div className="rounded-lg border border-border bg-secondary/70 px-3 py-2 text-muted-foreground shrink-0">
              You
            </div>
            <div className="w-6 border-t border-dashed border-border" />
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-primary font-semibold shrink-0">
              Kernel
            </div>
            <div className="w-6 border-t border-dashed border-border" />
            <div className="flex flex-col gap-1.5">
              {agents.map((a) => (
                <div key={a.name} className="flex items-center gap-1.5">
                  <div className="size-1.5 rounded-full bg-foreground/40" />
                  <span className="text-foreground">{a.name}</span>
                </div>
              ))}
            </div>
            <div className="w-6 border-t border-dashed border-border" />
            <div className="rounded-lg border border-border bg-secondary/70 px-3 py-2 text-muted-foreground shrink-0">
              ~/matrixos/
            </div>
          </div>
        </div>

        {/* Agent cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {agents.map((agent) => {
            const Icon = agent.icon;
            return (
              <div
                key={agent.name}
                className="rounded-2xl border border-border bg-card p-5 hover:shadow-lg hover:border-primary/20 transition-all duration-300"
              >
                <div className="size-10 rounded-xl border border-border bg-secondary/50 flex items-center justify-center mb-3">
                  <Icon className="size-5 text-foreground/70" />
                </div>
                <h3 className="text-sm font-semibold mb-1">{agent.name}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                  {agent.role}
                </p>
                <div className="rounded-lg bg-secondary/70 border border-border/50 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground leading-relaxed">
                  {agent.example}
                </div>
              </div>
            );
          })}
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
            An <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.3em]">operating system.</span>
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
                  Apps, profiles, config, AI personality. All stored as real
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
            <div className="size-10 rounded-xl bg-secondary/50 border border-border flex items-center justify-center mb-4">
              <ShieldIcon className="size-5 text-foreground/70" />
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
              Discord, Slack. All connected to one identity.
            </p>
            <div className="flex flex-wrap gap-2">
              {["Web", "Telegram", "WhatsApp", "Discord", "Slack", "CLI"].map((ch) => (
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

          {/* Self-Expanding */}
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

          {/* TDD */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300 flex flex-col">
            <h3 className="text-lg font-semibold mb-1">Test-driven</h3>
            <p className="text-sm text-muted-foreground leading-relaxed flex-1">
              Every component is tested before it ships. 993 tests across 85
              files. The OS trusts itself because it verifies itself.
            </p>
            <div className="mt-4 rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
              <div><span className="text-success">PASS</span> kernel/spawn.test.ts</div>
              <div><span className="text-success">PASS</span> gateway/dispatch.test.ts</div>
              <div><span className="text-success">PASS</span> cli/cli.test.ts</div>
              <div className="pt-1 text-success">993 tests passed</div>
            </div>
          </div>

          {/* Mobile App */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="size-10 rounded-xl bg-secondary/50 border border-border flex items-center justify-center mb-4">
              <SmartphoneIcon className="size-5 text-foreground/70" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Mobile app</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              Native iOS and Android via Expo. Clerk auth, streaming chat,
              Mission Control, and push notifications. Your OS in your pocket.
            </p>
            <div className="flex flex-wrap gap-2">
              {["iOS", "Android", "Clerk Auth", "Push"].map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-full border border-border bg-secondary/50 text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Plugin System */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="size-10 rounded-xl bg-secondary/50 border border-border flex items-center justify-center mb-4">
              <PuzzleIcon className="size-5 text-foreground/70" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Plugin system</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              Manifest-based discovery with void and modifying hooks, custom
              routes, services, and built-in security scanning.
            </p>
            <div className="rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
              <div><span className="text-primary">hooks:</span> void + modifying</div>
              <div><span className="text-primary">routes:</span> custom endpoints</div>
              <div><span className="text-primary">scan:</span> security audit</div>
            </div>
          </div>

          {/* Browser Automation */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="size-10 rounded-xl bg-secondary/50 border border-border flex items-center justify-center mb-4">
              <MonitorIcon className="size-5 text-foreground/70" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Browser automation</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              Playwright MCP with 18 composite actions, role-based snapshots,
              and persistent session management.
            </p>
            <div className="rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
              <div><span className="text-primary">actions:</span> 18 composites</div>
              <div><span className="text-primary">snapshots:</span> role-based</div>
              <div><span className="text-primary">sessions:</span> persistent</div>
            </div>
          </div>

          {/* Web Tools */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="size-10 rounded-xl bg-secondary/50 border border-border flex items-center justify-center mb-4">
              <SearchIcon className="size-5 text-foreground/70" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Web tools</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              web_fetch with Cloudflare Markdown, Readability, and Firecrawl
              fallback. web_search via Brave, Perplexity, and Grok.
            </p>
            <div className="rounded-lg bg-secondary/70 border border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
              <div><span className="text-primary">fetch:</span> CF / Readability / Firecrawl</div>
              <div><span className="text-primary">search:</span> Brave / Perplexity / Grok</div>
            </div>
          </div>

          {/* Settings Dashboard */}
          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-300">
            <div className="size-10 rounded-xl bg-secondary/50 border border-border flex items-center justify-center mb-4">
              <SlidersHorizontalIcon className="size-5 text-foreground/70" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Settings dashboard</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              macOS-style settings panel. Configure agent, channels, skills,
              cron jobs, security, and plugins from one place.
            </p>
            <div className="flex flex-wrap gap-2">
              {["Agent", "Channels", "Skills", "Cron", "Security", "Plugins"].map((tab) => (
                <span
                  key={tab}
                  className="text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-full border border-border bg-secondary/50 text-muted-foreground"
                >
                  {tab}
                </span>
              ))}
            </div>
          </div>

          {/* Architecture metaphor card */}
          <div className="md:col-span-6 rounded-2xl border border-border bg-card overflow-hidden hover:shadow-lg hover:border-primary/20 transition-all duration-300">
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
                ["RAM", "Context window (1M tokens)"],
                ["Kernel", "Main agent + 26 IPC tools"],
                ["Processes", "5 sub-agents"],
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

/* ──────────────────────────── Skills Showcase ──────────────────────── */

function SkillsShowcase() {
  const skills = [
    { name: "Summarize", icon: <FileTextIcon className="size-4" />, desc: "Condense long text into key points" },
    { name: "Weather", icon: <ZapIcon className="size-4" />, desc: "Current conditions and forecasts" },
    { name: "Reminder", icon: <MessageSquareIcon className="size-4" />, desc: "Schedule and manage notifications" },
    { name: "Budget Helper", icon: <LayersIcon className="size-4" />, desc: "Track spending and savings goals" },
    { name: "Study Timer", icon: <BrainIcon className="size-4" />, desc: "Pomodoro sessions with break reminders" },
    { name: "Setup Wizard", icon: <SparklesIcon className="size-4" />, desc: "Onboard new users, configure the OS" },
    { name: "Skill Creator", icon: <WrenchIcon className="size-4" />, desc: "Create new skills from descriptions" },
  ];

  return (
    <section id="skills" className="py-24 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-16">
          <Badge
            variant="outline"
            className="mb-4 border-primary/30 bg-card/80 text-primary font-mono text-xs tracking-widest uppercase"
          >
            Skills
          </Badge>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Teach it anything.{" "}
            <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.3em]">It remembers.</span>
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Skills are markdown files with frontmatter. The kernel loads them on demand.
            Seven built-in, and you can create your own with the Skill Creator.
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="rounded-xl border border-border bg-card p-4 hover:shadow-md hover:border-primary/20 transition-all duration-200"
            >
              <div className="flex items-center gap-2.5 mb-2">
                <div className="size-8 rounded-lg bg-secondary/70 border border-border/50 flex items-center justify-center text-muted-foreground">
                  {skill.icon}
                </div>
                <span className="text-sm font-semibold">{skill.name}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {skill.desc}
              </p>
            </div>
          ))}
          <div className="rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4 flex flex-col items-center justify-center text-center">
            <span className="text-2xl text-primary mb-1">+</span>
            <span className="text-xs font-semibold text-primary">Create your own</span>
            <span className="text-[10px] text-muted-foreground mt-1">
              Describe it, the OS writes it
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── OpenClaw Bridge ─────────────────────── */

function OpenClawBridge() {
  const sharedFeatures = [
    "Multi-channel messaging",
    "Skills & plugins",
    "Persistent memory",
    "Browser automation",
    "Web search & fetch",
    "Full system access",
    "Proactive scheduling",
    "Self-hosted & private",
    "Open source",
    "Test-driven",
  ];

  const matrixOnlyFeatures = [
    "Visual desktop OS",
    "Self-healing & repair",
    "Self-expanding agents",
    "Federated identity",
    "AI-to-AI communication",
    "Peer-to-peer device sync",
    "Native mobile app (Expo)",
    "Plugin system with hooks",
    "Settings dashboard",
    "Web 4 platform vision",
  ];

  return (
    <section id="vs-openclaw" className="py-24 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="rounded-3xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden">
          <div className="p-8 sm:p-12 md:p-16">
            {/* Header */}
            <div className="text-center mb-12">
              <Badge
                variant="outline"
                className="mb-6 border-primary/30 bg-primary/10 text-primary font-mono text-[10px] tracking-[0.2em] uppercase backdrop-blur-sm py-1.5 px-4"
              >
                Inspired By
              </Badge>

              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-6 leading-tight">
                Standing on the shoulders{" "}
                <br className="hidden sm:block" />
                <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.15em]">
                  of open source.
                </span>
              </h2>

              <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
                OpenClaw proved that AI should run on your machine, work from any
                chat app, and write its own skills.{" "}
                <span className="text-foreground font-medium">
                  Matrix OS takes that foundation further: a full operating system.
                </span>
              </p>
            </div>

            {/* Comparison table */}
            <div className="rounded-2xl border border-border overflow-hidden mb-12">
              {/* Table header */}
              <div className="grid grid-cols-[1fr_90px_90px] sm:grid-cols-[1fr_150px_150px] border-b border-border bg-secondary/30">
                <div className="px-4 sm:px-5 py-3" />
                <div className="px-3 sm:px-5 py-3 flex items-center justify-center border-l border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/openclaw-icon.png"
                    alt="OpenClaw"
                    className="size-5 rounded-sm mr-1.5 hidden sm:block"
                    loading="lazy"
                  />
                  <span className="text-xs sm:text-sm font-semibold text-muted-foreground whitespace-nowrap">
                    OpenClaw
                  </span>
                </div>
                <div className="px-3 sm:px-5 py-3 flex items-center justify-center border-l border-primary/20 bg-primary/5">
                  <img
                    src="/logo.png"
                    alt="Matrix OS"
                    className="size-5 rounded-sm mr-1.5 hidden sm:block"
                  />
                  <span className="text-xs sm:text-sm font-semibold text-primary whitespace-nowrap">
                    Matrix OS
                  </span>
                </div>
              </div>

              {/* Shared features */}
              {sharedFeatures.map((feature) => (
                <div
                  key={feature}
                  className="grid grid-cols-[1fr_90px_90px] sm:grid-cols-[1fr_150px_150px] border-b border-border/40"
                >
                  <div className="px-4 sm:px-5 py-2.5 text-xs sm:text-sm text-muted-foreground">
                    {feature}
                  </div>
                  <div className="px-3 sm:px-5 py-2.5 flex items-center justify-center border-l border-border">
                    <CheckIcon className="size-4 text-emerald-500" />
                  </div>
                  <div className="px-3 sm:px-5 py-2.5 flex items-center justify-center border-l border-primary/20 bg-primary/[0.03]">
                    <CheckIcon className="size-4 text-emerald-500" />
                  </div>
                </div>
              ))}

              {/* Divider */}
              <div className="grid grid-cols-[1fr_90px_90px] sm:grid-cols-[1fr_150px_150px] border-b border-border bg-secondary/50">
                <div className="px-4 sm:px-5 py-2 text-[10px] font-mono uppercase tracking-widest text-primary font-semibold">
                  And then some
                </div>
                <div className="px-3 sm:px-5 py-2 border-l border-border" />
                <div className="px-3 sm:px-5 py-2 border-l border-primary/20 bg-primary/5" />
              </div>

              {/* Matrix OS only features */}
              {matrixOnlyFeatures.map((feature, i) => (
                <div
                  key={feature}
                  className={`grid grid-cols-[1fr_90px_90px] sm:grid-cols-[1fr_150px_150px] border-b border-border/40 ${
                    i === matrixOnlyFeatures.length - 1 ? "border-b-0" : ""
                  }`}
                >
                  <div className="px-4 sm:px-5 py-2.5 text-xs sm:text-sm text-foreground font-medium">
                    {feature}
                  </div>
                  <div className="px-3 sm:px-5 py-2.5 flex items-center justify-center border-l border-border">
                    <MinusIcon className="size-3.5 text-muted-foreground/25" />
                  </div>
                  <div className="px-3 sm:px-5 py-2.5 flex items-center justify-center border-l border-primary/20 bg-primary/[0.06]">
                    <CheckIcon className="size-4 text-primary" />
                  </div>
                </div>
              ))}
            </div>

            {/* Closing */}
            <div className="text-center">
              <p className="text-xl sm:text-2xl font-bold tracking-tight mb-2">
                We didn&apos;t just match it.
              </p>
              <p className="text-muted-foreground mb-8 max-w-lg mx-auto leading-relaxed">
                We built an operating system around it. Still open source.
                Still self-hosted.{" "}
                <span className="text-foreground font-medium">Still yours.</span>
              </p>
              <Button size="lg" className="h-11 px-7 text-sm rounded-xl" asChild>
                <a href="/signup">
                  Try Matrix OS
                  <ArrowRightIcon className="size-4 ml-1" />
                </a>
              </Button>
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
    <section id="web4" className="py-24 px-6">
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
              This is <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.3em]">Web 4</span>
            </h2>

            <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-12 leading-relaxed">
              Your operating system, messaging, social media, AI assistant, apps,
              games, and identity. All one thing.
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
                  desc: "Laptop, phone, cloud. All equal. Git is the sync fabric. No central server.",
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
          Get your own <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.3em]">Matrix OS</span>
        </h2>
        <p className="text-muted-foreground mb-10 leading-relaxed max-w-lg mx-auto">
          Sign up to receive your personal instance at
          <span className="font-mono text-foreground"> you.matrix-os.com</span>.
          Build apps, connect channels, customize your AI.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap mb-8">
          <SignedOut>
            <Button size="lg" className="h-12 px-8 text-base rounded-xl" asChild>
              <a href="/signup">
                Get your instance
                <ArrowRightIcon className="size-4 ml-1" />
              </a>
            </Button>
          </SignedOut>
          <SignedIn>
            <Button size="lg" className="h-12 px-8 text-base rounded-xl" asChild>
              <a href="/dashboard">
                Go to Dashboard
                <ArrowRightIcon className="size-4 ml-1" />
              </a>
            </Button>
          </SignedIn>
          <Button variant="outline" size="lg" className="h-12 px-8 text-base rounded-xl bg-card/60" asChild>
            <a href="/whitepaper">
              <BookOpenIcon className="size-4" />
              Read the whitepaper
            </a>
          </Button>
        </div>

        <div className="flex items-center justify-center gap-4 flex-wrap mb-10">
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://img.shields.io/github/stars/HamedMP/matrix-os?style=flat&logo=github&label=Stars"
              alt="GitHub stars"
              className="h-5"
              loading="lazy"
            />
          </a>
          <Badge variant="outline" className="text-xs font-mono">
            926 tests passing
          </Badge>
        </div>

        <p className="text-[11px] text-muted-foreground mb-8">
          Built for the{" "}
          <a
            href="https://cv.inc/e/claude-code-hackathon"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Anthropic Hackathon
          </a>
          . The entire system (kernel, shell, this page) is built with Claude Code.
        </p>

        <blockquote className="mt-12 max-w-xl mx-auto border-l-2 border-primary/30 pl-6 text-left">
          <p className="text-sm text-muted-foreground italic leading-relaxed">
            &quot;This is Matrix OS. It&apos;s not just an AI assistant and
            it&apos;s not just an operating system. It&apos;s both. And
            it&apos;s also your social network, your messaging platform, and
            your game console. One identity. One platform. Every device. This
            is Web 4.&quot;
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
          <img src="/logo.png" alt="Matrix OS" className="size-5 rounded" />
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
            href="https://deepwiki.com/HamedMP/matrix-os/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            DeepWiki
          </a>
          <a
            href="/whitepaper"
            className="hover:text-foreground transition-colors"
          >
            Whitepaper
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
