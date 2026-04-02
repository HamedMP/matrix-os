import type { Metadata } from "next";
import { ArrowRightIcon, GithubIcon, ArrowLeftIcon } from "lucide-react";

export const metadata: Metadata = {
  title: "Technical Details | Matrix OS",
  description:
    "How Matrix OS works under the hood: architecture, design principles, the OS metaphor, Web 4 vision, and heritage from OpenClaw.",
  openGraph: {
    title: "Matrix OS - Technical Details",
    description:
      "Architecture, design principles, and the computing paradigm behind the OS that builds itself.",
    url: "https://matrix-os.com/technical",
    siteName: "Matrix OS",
    type: "article",
  },
};

export default function TechnicalPage() {
  return (
    <div className="min-h-screen bg-[#f5f0e8] text-[#191919]">
      <Nav />
      <TechHero />
      <OSMetaphor />
      <Architecture />
      <Principles />
      <Heritage />
      <Web4Vision />
      <TechStack />
      <Numbers />
      <TechFooter />
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
          <a href="/#how" className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors">
            How it works
          </a>
          <a href="/whitepaper" className="text-sm text-[#191919]/70 hover:text-[#191919] transition-colors">
            Whitepaper
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

        <a
          href="/signup"
          className="inline-flex items-center gap-1.5 bg-[#191919] text-[#f5f0e8] text-sm px-4 py-2 rounded-full hover:bg-[#333] transition-colors"
        >
          Join the waitlist
        </a>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── Hero ─────────────────────────────── */

function TechHero() {
  return (
    <section className="pt-32 md:pt-44 pb-16 px-6">
      <div className="mx-auto max-w-[900px]">
        <a
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-[#191919]/40 hover:text-[#191919]/70 transition-colors mb-8"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to home
        </a>
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-6 font-medium">
          Technical Details
        </p>
        <h1
          className="text-4xl sm:text-5xl md:text-[56px] font-bold leading-[1.1] tracking-[-0.02em] mb-8"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Under the hood
        </h1>
        <p className="text-lg md:text-xl text-[#191919]/60 leading-relaxed max-w-[650px] mb-6">
          Matrix OS treats an LLM as a literal operating system kernel. This
          page covers the architecture, design decisions, heritage, and the
          computing paradigm we call Web 4.
        </p>
        <div className="flex items-center gap-6 text-sm text-[#191919]/40">
          <span>April 2026</span>
          <span>15 min read</span>
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-[#191919]/70 transition-colors"
          >
            <GithubIcon className="size-3.5" />
            Source
          </a>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── OS Metaphor ─────────────────────────── */

function OSMetaphor() {
  const rows = [
    { traditional: "CPU", matrix: "Claude Opus 4.6", note: "Reasoning engine that executes all instructions" },
    { traditional: "RAM", matrix: "Context window (1M tokens)", note: "Working memory for the current task" },
    { traditional: "Kernel", matrix: "Agent SDK + system prompt", note: "Core loop that dispatches tools and sub-agents" },
    { traditional: "Processes", matrix: "Sub-agents", note: "Isolated workers with their own context windows" },
    { traditional: "Disk", matrix: "File system (~/)", note: "Persistent storage -- apps, data, config, identity" },
    { traditional: "System calls", matrix: "MCP tools", note: "Typed interfaces the kernel exposes to user space" },
    { traditional: "Device drivers", matrix: "Channel adapters", note: "Telegram, WhatsApp, Discord, Slack, Voice, Web" },
    { traditional: "IPC", matrix: "Tool results + file watches", note: "How the kernel and shells communicate" },
    { traditional: "BIOS / Firmware", matrix: "SOUL (soul.md)", note: "Identity, personality, behavioral constraints" },
    { traditional: "Shell", matrix: "Web desktop / chat / CLI", note: "Multiple renderers, same kernel underneath" },
  ];

  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          The core idea
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-6"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          An LLM as a <span className="italic">literal</span> operating system
        </h2>
        <p className="text-[#191919]/60 leading-relaxed max-w-[700px] mb-12">
          This is not a metaphor for marketing. Every concept in traditional OS
          design maps directly to a component in Matrix OS. The LLM is the CPU.
          The context window is RAM. Files are files.
        </p>

        <div className="rounded-xl border border-[#d5cfc4] overflow-hidden">
          <div className="grid grid-cols-[1fr_1.2fr_1.5fr] bg-[#e5dfd4] text-sm font-medium">
            <div className="px-5 py-3 border-r border-[#d5cfc4]">Traditional OS</div>
            <div className="px-5 py-3 border-r border-[#d5cfc4]">Matrix OS</div>
            <div className="px-5 py-3">Role</div>
          </div>
          {rows.map((row, i) => (
            <div
              key={row.traditional}
              className={`grid grid-cols-[1fr_1.2fr_1.5fr] text-sm ${
                i % 2 === 0 ? "bg-[#f5f0e8]" : "bg-[#f0ebe1]"
              }`}
            >
              <div className="px-5 py-3 border-r border-[#d5cfc4] font-mono text-[#191919]/50">
                {row.traditional}
              </div>
              <div className="px-5 py-3 border-r border-[#d5cfc4] font-medium">
                {row.matrix}
              </div>
              <div className="px-5 py-3 text-[#191919]/60">{row.note}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── Architecture ────────────────────────── */

function Architecture() {
  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <div className="rounded-2xl bg-[#e5dfd4] p-8 sm:p-12 md:p-16">
          <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
            Architecture
          </p>
          <h2
            className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-12"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Gateway &rarr; Kernel &rarr; Files
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
            {[
              {
                title: "Gateway (Hono)",
                items: [
                  "HTTP + WebSocket server",
                  "Channel adapters (Telegram, WhatsApp, Discord, Slack)",
                  "Voice pipeline (STT/TTS)",
                  "Auth, rate limiting, body limits",
                  "Routes everything to the kernel",
                ],
              },
              {
                title: "Kernel (Agent SDK)",
                items: [
                  "Claude Opus 4.6 with 1M context",
                  "MCP tools for file I/O, shell, apps",
                  "Sub-agent spawning for heavy tasks",
                  "Session resume for multi-turn conversations",
                  "SOUL identity injected at cache level",
                ],
              },
              {
                title: "File System (~/)",
                items: [
                  "Apps in ~/apps/ (HTML, codebases)",
                  "Data in ~/data/ (SQLite, JSON)",
                  "Agents in ~/agents/ (markdown definitions)",
                  "Config in ~/system/ (JSON files)",
                  "Git-versioned, peer-to-peer sync",
                ],
              },
            ].map((col) => (
              <div key={col.title}>
                <h3
                  className="text-lg font-bold mb-4"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {col.title}
                </h3>
                <ul className="space-y-2">
                  {col.items.map((item) => (
                    <li key={item} className="text-sm text-[#191919]/60 leading-relaxed flex gap-2">
                      <span className="text-[#191919]/20 shrink-0">&mdash;</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="font-mono text-sm text-[#191919]/50 bg-[#f5f0e8] rounded-lg p-6 overflow-x-auto">
            <pre>{`Voice    ──┐
Telegram ──┤
WhatsApp ──┤
Discord  ──┼──► Gateway ──► Dispatcher ──► Kernel ──► File Mutations
Slack    ──┤                                             │
Web Chat ──┤                                             ▼
REST API ──┘                                     Shell watches ~/
                                                 UI updates in real-time`}</pre>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── Principles ──────────────────────────── */

function Principles() {
  const principles = [
    {
      num: "I",
      title: "Everything Is a File",
      tag: "NON-NEGOTIABLE",
      desc: "Every piece of state is a file on disk. Apps, config, identity, agent definitions, user data. Backup = copy a folder. Share = send a file. No opaque databases for core state.",
    },
    {
      num: "II",
      title: "Agent Is the Kernel",
      desc: "The Claude Agent SDK is not bolted on -- it IS the kernel. Full machine control: file system, shell, processes, network. Every user interaction flows through the agent.",
    },
    {
      num: "III",
      title: "Headless Core, Multi-Shell",
      desc: "The core works without any UI. The web desktop is one renderer. Telegram, WhatsApp, Discord, Slack are additional shells. CLI, mobile, voice-only, API -- all read the same files.",
    },
    {
      num: "IV",
      title: "Self-Healing & Self-Expanding",
      desc: "The OS detects failures, diagnoses root causes, and patches itself. It creates new capabilities by writing new agent files and tools. Git snapshots before every mutation.",
    },
    {
      num: "V",
      title: "Simplicity Over Sophistication",
      desc: "Single-process async before worker threads. File-based IPC before message queues. SQLite before Postgres. HTML apps before full-stack frameworks. Escalate only when the simpler approach fails.",
    },
    {
      num: "VI",
      title: "Defense in Depth",
      tag: "NON-NEGOTIABLE",
      desc: "Auth matrix, input validation, resource limits, timeouts on every external call, constant-time secret comparison, atomic file writes. Security is part of the spec, not a follow-up.",
    },
    {
      num: "VII",
      title: "Test-Driven Development",
      tag: "NON-NEGOTIABLE",
      desc: "Failing tests first, then implement. 99-100% coverage target. Spike before spec. Integration tests against real SDK behavior, not just docs. 2,800+ tests and counting.",
    },
  ];

  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          Constitution
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Seven design principles
        </h2>

        <div className="space-y-px">
          {principles.map((p) => (
            <div
              key={p.num}
              className="grid grid-cols-[60px_1fr] md:grid-cols-[60px_200px_1fr] gap-4 p-5 bg-[#f0ebe1]/60 first:rounded-t-xl last:rounded-b-xl"
            >
              <span className="font-mono text-sm text-[#191919]/30 pt-0.5">
                {p.num}
              </span>
              <div className="md:contents">
                <h3 className="font-bold text-base flex items-center gap-2">
                  {p.title}
                  {p.tag && (
                    <span className="text-[10px] tracking-[0.08em] uppercase font-medium px-2 py-0.5 rounded-full bg-[#191919]/8 text-[#191919]/50">
                      {p.tag}
                    </span>
                  )}
                </h3>
                <p className="text-sm text-[#191919]/60 leading-relaxed">
                  {p.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Heritage ───────────────────────────── */

function Heritage() {
  const comparisons = [
    {
      pattern: "Gateway",
      openclaw: "Routes chat messages from channels to agent, response back to channel",
      matrixos: "Routes input to kernel, output is file mutations. Shell watches filesystem for changes.",
    },
    {
      pattern: "Skills",
      openclaw: "YAML + Markdown files compiled into system prompt. Guide the agent, don't execute.",
      matrixos: "Same pattern, but skills can also trigger sub-agents and file generation.",
    },
    {
      pattern: "Sessions",
      openclaw: "In-memory conversation state per channel/user",
      matrixos: "Agent SDK resume tokens + file-based session state. Survives restarts.",
    },
    {
      pattern: "Output",
      openclaw: "Send message back to originating channel",
      matrixos: "Write files to disk. Every action = file created, modified, or deleted.",
    },
    {
      pattern: "Channels",
      openclaw: "Telegram, Discord, Slack, iMessage, Web -- all first-class",
      matrixos: "Same channels, plus Voice as primary gateway. Matrix protocol for federation.",
    },
    {
      pattern: "Extensibility",
      openclaw: "Plugin SDK with hooks, tool registration, config injection",
      matrixos: "Two-tier: file-based (write a markdown skill) + code-based (MCP tools).",
    },
  ];

  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          Heritage
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr] gap-12 items-start mb-16">
          <h2
            className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Built on <span className="italic">OpenClaw&apos;s</span> shoulders
          </h2>
          <p className="text-[#191919]/60 leading-relaxed md:pt-2">
            <a
              href="https://github.com/open-claw/openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-[#191919]/20 hover:decoration-[#191919]/50 transition-colors"
            >
              OpenClaw
            </a>{" "}
            proved that a personal AI agent -- reachable from any chat platform,
            with persistent memory and full system access -- changes how people
            use computers. Matrix OS takes that foundation and adds a generative
            layer: the agent doesn&apos;t just orchestrate tools, it creates new
            software in real-time.
          </p>
        </div>

        <div className="rounded-xl border border-[#d5cfc4] overflow-hidden">
          <div className="grid grid-cols-[100px_1fr_1fr] bg-[#e5dfd4] text-sm font-medium">
            <div className="px-5 py-3 border-r border-[#d5cfc4]">Pattern</div>
            <div className="px-5 py-3 border-r border-[#d5cfc4]">OpenClaw</div>
            <div className="px-5 py-3">Matrix OS</div>
          </div>
          {comparisons.map((row, i) => (
            <div
              key={row.pattern}
              className={`grid grid-cols-[100px_1fr_1fr] text-sm ${
                i % 2 === 0 ? "bg-[#f5f0e8]" : "bg-[#f0ebe1]"
              }`}
            >
              <div className="px-5 py-3 border-r border-[#d5cfc4] font-mono text-[#191919]/50 text-xs">
                {row.pattern}
              </div>
              <div className="px-5 py-3 border-r border-[#d5cfc4] text-[#191919]/60">
                {row.openclaw}
              </div>
              <div className="px-5 py-3 text-[#191919]/80">{row.matrixos}</div>
            </div>
          ))}
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-px bg-[#d5cfc4] border border-[#d5cfc4] rounded-xl overflow-hidden">
          {[
            {
              title: "What we took",
              desc: "Gateway pattern, skills-as-docs, channel adapters, single-agent routing, tool system with typed schemas, hooks at boundaries.",
            },
            {
              title: "What we simplified",
              desc: "No multi-tenant design, no platform-specific code paths, lighter dependency tree, file-based config over environment variables.",
            },
            {
              title: "What we invented",
              desc: "Generative apps (software from conversation), file-as-output, OS metaphor (LLM = CPU), self-healing kernel, peer-to-peer git sync, Web 4.",
            },
          ].map((item) => (
            <div key={item.title} className="bg-[#f5f0e8] p-8">
              <h3
                className="text-lg font-bold mb-3"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                {item.title}
              </h3>
              <p className="text-sm text-[#191919]/60 leading-relaxed">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Web 4 ─────────────────────────────── */

function Web4Vision() {
  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <div className="rounded-2xl bg-[#e5dfd4] p-8 sm:p-12 md:p-16">
          <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
            The bigger picture
          </p>
          <h2
            className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-6"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Web 4: the <span className="italic">unification</span>
          </h2>
          <p className="text-[#191919]/60 leading-relaxed max-w-[700px] mb-12">
            Every era of computing unified previously separate things. Web 4
            unifies your OS, messaging, social media, AI, apps, games, and
            identity into one platform.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 mb-12">
            {[
              { era: "Web 1", desc: "Static pages. Information published, consumed passively." },
              { era: "Web 2", desc: "Platforms. Social, messaging, apps -- all siloed. Identity scattered." },
              { era: "Web 3", desc: "Decentralization. Crypto, wallets. Promised ownership, delivered complexity." },
              { era: "Web 4", desc: "Unification. One AI, one identity, one file system, every device." },
            ].map((w, i) => (
              <div
                key={w.era}
                className={`p-5 rounded-lg ${
                  i === 3
                    ? "bg-[#191919] text-[#f5f0e8]"
                    : "bg-[#f5f0e8]/60"
                }`}
              >
                <p className={`text-xs font-mono mb-2 ${i === 3 ? "text-[#f5f0e8]/50" : "text-[#191919]/30"}`}>
                  {w.era}
                </p>
                <p className={`text-sm leading-relaxed ${i === 3 ? "text-[#f5f0e8]/80" : "text-[#191919]/60"}`}>
                  {w.desc}
                </p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3
                className="text-lg font-bold mb-4"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                Matrix Protocol foundation
              </h3>
              <ul className="space-y-2">
                {[
                  "Federated identity: @user:matrix-os.com",
                  "Server-to-server federation with the broader Matrix ecosystem",
                  "End-to-end encryption (Olm/Megolm) for all communication",
                  "AI-to-AI protocol via custom Matrix event types",
                  "Any Matrix client (Element, FluffyChat) can talk to Matrix OS",
                ].map((item) => (
                  <li key={item} className="text-sm text-[#191919]/60 leading-relaxed flex gap-2">
                    <span className="text-[#191919]/20 shrink-0">&mdash;</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3
                className="text-lg font-bold mb-4"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                Peer-to-peer sync
              </h3>
              <ul className="space-y-2">
                {[
                  "Every device runs its own Matrix OS instance",
                  "Home directory (~/) is a git repo",
                  "Devices sync via git push/pull -- no central server required",
                  "Cloud instance is just another peer (always-on)",
                  "Conflict resolution is AI-assisted: kernel reads git markers and merges",
                ].map((item) => (
                  <li key={item} className="text-sm text-[#191919]/60 leading-relaxed flex gap-2">
                    <span className="text-[#191919]/20 shrink-0">&mdash;</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── Tech Stack ──────────────────────────── */

function TechStack() {
  const stack = [
    { category: "Runtime", items: "Node.js 24+, TypeScript 5.5+ (strict), ES modules" },
    { category: "AI", items: "Claude Agent SDK V1 query() + resume, Opus 4.6, 1M context" },
    { category: "Frontend", items: "Next.js 16, React 19, Turbopack, React Compiler" },
    { category: "Backend", items: "Hono (HTTP, WebSocket, channel adapters)" },
    { category: "Database", items: "SQLite / Drizzle ORM (kernel), Postgres / Kysely (social)" },
    { category: "Validation", items: "Zod 4 (schemas, tool params, API contracts)" },
    { category: "Testing", items: "Vitest, @vitest/coverage-v8, TDD workflow" },
    { category: "Protocol", items: "Matrix (federation, E2E encryption, identity)" },
    { category: "Channels", items: "Telegram, WhatsApp (Baileys), Discord.js, Slack Bolt, Voice" },
    { category: "Infra", items: "Docker, OrbStack, Hetzner VPS, pnpm + bun" },
  ];

  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          Stack
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-12"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          What it&apos;s built with
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-[#d5cfc4] border border-[#d5cfc4] rounded-xl overflow-hidden">
          {stack.map((s) => (
            <div key={s.category} className="bg-[#f5f0e8] p-5 flex gap-4">
              <span className="shrink-0 text-xs font-mono text-[#191919]/30 pt-0.5 w-20">
                {s.category}
              </span>
              <span className="text-sm text-[#191919]/70">{s.items}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Numbers ────────────────────────────── */

function Numbers() {
  const stats = [
    { value: "2,800+", label: "Tests passing" },
    { value: "100K+", label: "Lines of TypeScript" },
    { value: "214", label: "Test files" },
    { value: "8", label: "Packages" },
    { value: "46+", label: "Completed phases" },
    { value: "6+", label: "Channels" },
  ];

  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[#191919]/40 mb-4 font-medium">
          By the numbers
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold leading-tight tracking-[-0.02em] mb-12"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Built in public, <span className="italic">tested obsessively</span>
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-[#d5cfc4] border border-[#d5cfc4] rounded-xl overflow-hidden">
          {stats.map((s) => (
            <div key={s.label} className="bg-[#f5f0e8] p-6 text-center">
              <p
                className="text-2xl sm:text-3xl font-bold tracking-[-0.02em] mb-1"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                {s.value}
              </p>
              <p className="text-xs text-[#191919]/40">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Footer ─────────────────────────────── */

function TechFooter() {
  return (
    <section className="py-20 px-6">
      <div className="mx-auto max-w-[700px] text-center mb-16">
        <h2
          className="text-3xl sm:text-4xl font-bold tracking-[-0.02em] mb-6"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Want to go deeper?
        </h2>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <a
            href="/whitepaper"
            className="inline-flex items-center gap-2 bg-[#191919] text-[#f5f0e8] text-sm px-6 py-2.5 rounded-full hover:bg-[#333] transition-colors font-medium"
          >
            Read the whitepaper
            <ArrowRightIcon className="size-3.5" />
          </a>
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-[#191919]/60 hover:text-[#191919] transition-colors"
          >
            <GithubIcon className="size-3.5" />
            View source
          </a>
          <a
            href="/docs"
            className="inline-flex items-center gap-2 text-sm text-[#191919]/60 hover:text-[#191919] transition-colors"
          >
            Documentation
            <ArrowRightIcon className="size-3.5" />
          </a>
        </div>
      </div>

      <footer className="py-8 border-t border-[#d5cfc4]">
        <div className="mx-auto max-w-[1200px] flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Matrix OS" className="size-5 rounded" />
            <span className="text-sm text-[#191919]/50 font-mono">matrix-os.com</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-[#191919]/50">
            <a href="https://discord.gg/cSBBQWtPwV" target="_blank" rel="noopener noreferrer" className="hover:text-[#191919] transition-colors">Discord</a>
            <a href="https://x.com/joinmatrixos" target="_blank" rel="noopener noreferrer" className="hover:text-[#191919] transition-colors">X / Twitter</a>
            <a href="https://github.com/HamedMP/matrix-os" target="_blank" rel="noopener noreferrer" className="hover:text-[#191919] transition-colors">GitHub</a>
            <a href="/docs" className="hover:text-[#191919] transition-colors">Docs</a>
          </div>
        </div>
      </footer>
    </section>
  );
}
