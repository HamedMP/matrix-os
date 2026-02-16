"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PrinterIcon,
  LinkIcon,
  ChevronUpIcon,
  MenuIcon,
  XIcon,
} from "lucide-react";

const sections = [
  { id: "abstract", label: "Abstract" },
  { id: "introduction", label: "1. Introduction" },
  { id: "related-work", label: "2. Related Work" },
  { id: "architecture", label: "3. Architecture" },
  { id: "novel-paradigms", label: "4. Novel Paradigms" },
  { id: "implementation", label: "5. Implementation" },
  { id: "web4-vision", label: "6. Web 4 Vision" },
  { id: "evaluation", label: "7. Evaluation" },
  { id: "conclusion", label: "8. Conclusion" },
  { id: "references", label: "References" },
];

const WORD_COUNT = "~4,500";
const READING_TIME = "18 min read";

function copyLink() {
  navigator.clipboard.writeText("https://matrix-os.com/whitepaper");
}

export function WhitepaperContent() {
  const [tocOpen, setTocOpen] = useState(false);

  return (
    <>
      {/* Top bar */}
      <header className="fixed top-0 left-0 right-0 z-50 print:hidden">
        <div className="mx-auto max-w-5xl px-4 pt-4">
          <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-card/60 px-5 py-2.5 shadow-sm backdrop-blur-xl">
            <a href="/" className="flex items-center gap-2.5 group">
              <img
                src="/logo.png"
                alt="Matrix OS"
                className="size-7 rounded-lg shadow-sm"
              />
              <span className="font-mono text-sm font-semibold tracking-tight text-foreground">
                matrix-os
              </span>
            </a>

            <div className="flex items-center gap-2">
              <span className="hidden sm:inline text-xs text-muted-foreground">
                {READING_TIME}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={copyLink}
                title="Copy link"
              >
                <LinkIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => window.print()}
                title="Download PDF"
              >
                <PrinterIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground lg:hidden"
                onClick={() => setTocOpen(!tocOpen)}
              >
                {tocOpen ? (
                  <XIcon className="size-4" />
                ) : (
                  <MenuIcon className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 pt-24 pb-20">
        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-12">
          {/* TOC sidebar */}
          <aside
            className={`${tocOpen ? "block" : "hidden"} lg:block print:hidden`}
          >
            <nav className="sticky top-24">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Contents
              </p>
              <ul className="space-y-1.5">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      onClick={() => setTocOpen(false)}
                      className="block text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          {/* Main content */}
          <article className="prose-paper">
            {/* Title block */}
            <div className="mb-12 border-b border-border pb-8">
              <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
                Whitepaper
              </p>
              <h1 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
                Matrix OS: A Unified AI Operating System
              </h1>
              <p className="mb-4 text-lg leading-relaxed text-muted-foreground">
                From conversation to software in seconds. An architecture where
                the AI is the kernel, files are the truth, and every device is a
                peer.
              </p>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>{READING_TIME}</span>
                <span>{WORD_COUNT} words</span>
                <span>February 2026</span>
              </div>
            </div>

            {/* --- Abstract --- */}
            <section id="abstract">
              <h2>Abstract</h2>
              <p>
                Matrix OS is a unified AI operating system that treats the Claude
                Agent SDK as a literal kernel. Software is generated from natural
                language conversation, persisted as files, and delivered through
                any channel: a web desktop, Telegram, WhatsApp, Discord, Slack,
                or the Matrix federation protocol. The system produces real
                software in real time, heals itself when things break, expands
                its own capabilities by writing new agents and skills, and syncs
                across every device via git. This paper describes the
                architecture, the six non-negotiable design principles, three
                novel computing paradigms enabled by the platform, and a vision
                for Web 4: the unification of operating system, messaging, social
                network, AI assistant, and application marketplace under a single
                federated identity.
              </p>
            </section>

            {/* --- 1. Introduction --- */}
            <section id="introduction">
              <h2>1. Introduction</h2>
              <p>
                Modern computing is fragmented. A typical user relies on dozens
                of disconnected services: a messaging app, a social network, a
                cloud storage provider, an email client, a project management
                tool, a note-taking app, a calendar. Each has its own account,
                its own data model, its own interface conventions. Data moves
                between them only through manual export, brittle integrations, or
                corporate APIs that can be revoked at any time. The user&apos;s
                digital life is scattered across silos, none of which they truly
                own.
              </p>
              <p>
                At the same time, AI assistants have become remarkably capable.
                Large language models can write code, analyze data, summarize
                documents, and carry on nuanced conversations. Yet they remain
                isolated: you open a chat window, ask a question, get an answer,
                and close the window. The assistant has no persistence, no system
                access, no ability to act on your behalf across applications. It
                is intelligence without agency.
              </p>
              <p>
                Matrix OS starts from a different premise. Rather than building
                another application on top of an existing operating system, it
                treats the AI itself as the operating system&apos;s kernel. The
                AI has full machine control: file system, shell, processes,
                network. When you describe what you need, the kernel writes real
                software, saves it as files you own, and the system renders it
                immediately. There is no build step, no deployment pipeline, no
                app store. Software exists the moment the kernel writes it.
              </p>
              <p>
                The result is a system where software is generated, not
                installed; where the file system is the single source of truth;
                where the OS heals itself and grows new capabilities; and where
                the same kernel is reachable from a web desktop, a terminal, a
                messaging app, or an AI-to-AI protocol. This paper describes the
                architecture that makes this possible and the vision it enables.
              </p>
            </section>

            {/* --- 2. Related Work --- */}
            <section id="related-work">
              <h2>2. Related Work</h2>

              <h3>2.1 The Unix Philosophy and Plan 9</h3>
              <p>
                The idea that &quot;everything is a file&quot; originates with
                Unix<sup>[1]</sup>. Devices, processes, and network connections
                are all represented as file descriptors. Plan 9 from Bell
                Labs<sup>[2]</sup> extended this further: every resource in the
                system: including the network, the graphics display, and remote
                machines: was accessible through a file-system interface.
                Matrix OS inherits this philosophy directly. Applications,
                configuration, user data, agent definitions, and the AI&apos;s
                personality are all files on disk. Sharing an app means sending a
                file. Backing up the OS means copying a folder.
              </p>

              <h3>2.2 Personal Computing and Dynamic Media</h3>
              <p>
                Alan Kay&apos;s Dynabook vision<sup>[3]</sup> imagined a
                personal computer as a &quot;dynamic medium for creative
                thought.&quot; Xerox PARC realized portions of this with
                Smalltalk, where the programming environment and the user
                environment were the same thing: the system was always
                inspectable and modifiable. Bret Victor&apos;s work on direct
                manipulation interfaces<sup>[4]</sup> and Dynamicland&apos;s
                spatial computing<sup>[5]</sup> continued this tradition, asking
                what computing looks like when the boundary between creation and
                use dissolves. Matrix OS occupies this lineage: the user
                interacts with the same system the developer would, at whatever
                depth they choose.
              </p>

              <h3>2.3 AI Assistants and Agent Frameworks</h3>
              <p>
                Current AI assistants (ChatGPT, Claude, Copilot) are capable but
                stateless and sandboxed. They generate text but cannot act on
                systems. Agent frameworks such as LangChain, CrewAI, and
                AutoGen orchestrate LLM calls with tool use, but they run as
                applications within a traditional OS, not as the OS itself.
                Anthropic&apos;s Claude Agent SDK<sup>[6]</sup> provides the
                primitive Matrix OS builds on: a model that can invoke tools
                (Read, Write, Edit, Bash), spawn sub-agents, and maintain
                multi-turn conversations with resume capability. Matrix OS maps
                these primitives onto operating system concepts, turning tool
                calls into system calls and sub-agents into processes.
              </p>

              <h3>2.4 Federated Communication</h3>
              <p>
                The Matrix protocol<sup>[7]</sup> is an open standard for
                decentralized, real-time communication. It provides federated
                identity (globally unique user IDs), end-to-end encryption
                (Olm/Megolm), and extensible event types. ActivityPub powers the
                Fediverse (Mastodon, Pixelfed). Nostr provides censorship-
                resistant relays. Matrix OS adopts the Matrix protocol because it
                offers both human-to-human and machine-to-machine communication
                primitives, server-to-server federation, and an existing
                ecosystem of bridges to 30+ platforms.
              </p>

              <h3>2.5 Self-Modifying Systems</h3>
              <p>
                The idea that software can modify itself is not new. Genetic
                programming<sup>[8]</sup> evolves programs through selection.
                Autopoietic systems (Maturana and Varela<sup>[9]</sup>)
                self-produce their own components. Lisp systems have long
                supported runtime modification. What is new is combining
                self-modification with a large language model that understands
                intent. Matrix OS does not evolve through random mutation: it
                evolves through reasoned, goal-directed modification, mediated by
                a model that can read the entire system state and write
                improvements.
              </p>
            </section>

            {/* --- 3. Architecture --- */}
            <section id="architecture">
              <h2>3. Architecture</h2>

              <h3>3.1 The Core Metaphor</h3>
              <p>
                Matrix OS maps the Claude Agent SDK onto computer architecture:
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Computer Architecture</th>
                    <th>Matrix OS Equivalent</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>CPU</td>
                    <td>Claude Opus 4.6 (reasoning engine)</td>
                  </tr>
                  <tr>
                    <td>RAM</td>
                    <td>Context window (working memory)</td>
                  </tr>
                  <tr>
                    <td>Kernel</td>
                    <td>Main agent with tool access</td>
                  </tr>
                  <tr>
                    <td>Processes</td>
                    <td>Sub-agents spawned via Task tool</td>
                  </tr>
                  <tr>
                    <td>Disk</td>
                    <td>File system (~/apps, ~/data, ~/system)</td>
                  </tr>
                  <tr>
                    <td>System calls</td>
                    <td>Agent SDK tools (Read, Write, Edit, Bash)</td>
                  </tr>
                  <tr>
                    <td>IPC</td>
                    <td>File-based coordination between agents</td>
                  </tr>
                  <tr>
                    <td>Device drivers</td>
                    <td>MCP servers (external service connections)</td>
                  </tr>
                </tbody>
              </table>
              <p>
                This is not a loose analogy. The mapping is structural. The
                kernel (main agent) receives requests, routes them, spawns
                sub-agents (processes), and writes results to the file system
                (disk). Context window management is memory management. Prompt
                caching is page caching. Session resume is process hibernation.
              </p>

              <h3>3.2 Six Design Principles</h3>
              <ol>
                <li>
                  <strong>Everything Is a File.</strong> The file system is the
                  single source of truth. Applications, configuration, agent
                  definitions, user data, and the AI&apos;s personality are files
                  on disk.
                </li>
                <li>
                  <strong>Agent Is the Kernel.</strong> The Claude Agent SDK is
                  not a feature of the OS: it is the OS kernel. It has full
                  machine control and makes all routing decisions.
                </li>
                <li>
                  <strong>Headless Core, Multi-Shell.</strong> The core works
                  without a UI. The web desktop, messaging channels, CLI, and
                  API are all shells: interchangeable renderers that read the
                  same files.
                </li>
                <li>
                  <strong>Self-Healing and Self-Expanding.</strong> The OS
                  detects failures and patches itself. It creates new
                  capabilities by writing new agent files and skills. Git
                  snapshots ensure nothing is permanently lost.
                </li>
                <li>
                  <strong>Simplicity Over Sophistication.</strong> Single-process
                  async before worker threads. File-based IPC before message
                  queues. SQLite before Postgres. Escalate complexity only when
                  the simpler approach fails.
                </li>
                <li>
                  <strong>Test-Driven Development.</strong> Every component is
                  tested before implementation. 479 tests, near-total coverage.
                  The OS trusts itself because it verifies itself.
                </li>
              </ol>

              <h3>3.3 System Topology</h3>
              <p>
                The system has three layers. The <strong>gateway</strong> (Hono
                HTTP/WebSocket server) receives requests from all channels:
                browser WebSocket, REST API, Telegram polling, and future
                channels. It routes messages through a serial dispatch queue to
                the <strong>kernel</strong> (Claude Agent SDK), which reasons,
                invokes tools, spawns sub-agents, and writes results to the file
                system. The <strong>shell</strong> (Next.js 16 frontend) watches
                the file system via WebSocket and renders what it finds. The
                shell discovers applications: it does not know what exists
                ahead of time.
              </p>
              <p>
                A cron service and heartbeat runner live in the gateway, enabling
                proactive behavior: scheduled tasks, periodic kernel invocation,
                and active-hours awareness. The kernel is not purely reactive --
                it can reach out through any channel on a schedule.
              </p>

              <h3>3.4 SOUL and Identity</h3>
              <p>
                Each Matrix OS instance has a SOUL file
                (<code>~/system/soul.md</code>) that defines the AI&apos;s
                personality, values, and communication style. This file is
                injected into every kernel prompt. A separate identity file
                (<code>~/system/identity.md</code>) records the user&apos;s
                preferences. A user file (<code>~/system/user.md</code>)
                captures context that accumulates over time. Together, these
                produce a consistent, personalized AI that behaves the same
                across all channels.
              </p>

              <h3>3.5 Skills System</h3>
              <p>
                Skills are markdown files in <code>~/agents/skills/</code> with
                frontmatter metadata (name, description, triggers). The kernel
                loads a table of contents of all available skills into its system
                prompt. When a request matches a skill&apos;s triggers, the
                kernel loads the full skill body on demand. This is
                demand-paged knowledge: the kernel knows what skills exist
                without loading them all into memory. New skills can be
                created by the kernel itself, making the system self-expanding.
              </p>
            </section>

            {/* --- 4. Novel Paradigms --- */}
            <section id="novel-paradigms">
              <h2>4. Novel Computing Paradigms</h2>
              <p>
                Matrix OS has a property no other system has: the AI and the
                software are in the same system, continuously. The kernel can
                read everything, write everything, remember everything, and be
                reached from everywhere. This enables three computing paradigms
                that cannot exist in conventional systems.
              </p>

              <h3>4.1 Living Software</h3>
              <p>
                Software that evolves with use. Every time a user interacts with
                an application, the kernel can observe patterns and reshape the
                software. A user operates an expense tracker for a week; the
                kernel notices they always categorize by project and restructures
                the application around projects. A colleague uses the same
                template and it restructures around clients. Same starting point,
                divergent evolution. The git history of the application file
                shows software literally evolving.
              </p>
              <p>
                This is possible because the application, the data, and the
                usage telemetry are all files. The kernel reads all three and
                writes a new version. In conventional systems, the creator and
                the creation are in separate systems. In Matrix OS, they are the
                same system.
              </p>

              <h3>4.2 Socratic Computing</h3>
              <p>
                The OS argues back. The dialogue itself is the computing; the
                application, if one appears at all, is a byproduct. When a user
                says &quot;build me a CRM,&quot; the OS asks: &quot;What is your
                sales process? Do you track leads or deals? How many people use
                it?&quot; Not because it needs answers to generate HTML, but
                because the dialogue clarifies the user&apos;s thinking. By the
                time the CRM appears, the user understands their own process
                better.
              </p>
              <p>
                This extends beyond application generation. &quot;I need to save
                more money&quot; does not produce a budget app. It produces
                questions, pattern analysis, proposed experiments. The
                conversation is the computing. The dialogue becomes part of the
                application&apos;s lineage, stored in conversation history,
                queryable later: &quot;why was this app built this way?&quot;
              </p>

              <h3>4.3 Intent-Based Interfaces</h3>
              <p>
                No applications. Only persistent intentions that the system
                fulfills in whatever form is appropriate. &quot;Track my
                expenses&quot; is not an application: it is an intent that
                resolves differently depending on context: at a desktop, a visual
                dashboard; on Telegram, a text summary; at the end of the month,
                a generated report. The file system is the memory, not the UI.
                The UI is ephemeral, generated in the moment, shaped to the
                context.
              </p>
              <p>
                This draws on Mercury OS<sup>[10]</sup> (concept OS with
                intent-based flows), Dynamicland<sup>[5]</sup> (computing
                without fixed interfaces), and Calm Technology<sup>[11]</sup>
                (technology that informs without demanding attention). Matrix OS
                adds the missing ingredient: an AI kernel that can read the
                intent, the data, and the channel, and generate the appropriate
                interface at runtime.
              </p>

              <h3>4.4 Progressive Depth (Bruner&apos;s Modes)</h3>
              <p>
                Drawing on Jerome Bruner&apos;s theory of instruction<sup>
                  [12]
                </sup>
                , Matrix OS presents three interaction modes: enactive
                (action-based: voice, gestures, direct manipulation), iconic
                (image-based: visual applications, dashboards, spatial shell),
                and symbolic (language-based: code, terminal, file editing). A
                new user speaks to the OS. An intermediate user arranges windows
                and customizes the desktop. An expert user edits files directly.
                Same system, progressively revealed depth. All three are
                first-class citizens.
              </p>
            </section>

            {/* --- 5. Implementation --- */}
            <section id="implementation">
              <h2>5. Implementation</h2>

              <h3>5.1 Technology Stack</h3>
              <p>
                TypeScript 5.5+ with strict mode and ES modules. Node.js 22+
                runtime. Claude Agent SDK V1 with <code>query()</code> and{" "}
                <code>resume</code> for kernel operation. Next.js 16 with React
                19 for the shell. Hono for the HTTP/WebSocket gateway. SQLite
                via Drizzle ORM for structured data. Zod 4 for runtime
                validation. Vitest for testing. pnpm for dependency management.
              </p>

              <h3>5.2 Development Process</h3>
              <p>
                The system was built in phases following strict TDD. Each
                phase produces a demoable increment. At the time of writing, 479
                tests pass across 44 test files. Completed phases include: the
                kernel (agent SDK integration, IPC tools, hooks), the gateway
                (HTTP/WebSocket, concurrent dispatch, channels), the shell
                (desktop UI, chat panel, terminal, Mission Control), self-healing
                (heartbeat, healer agent, backup/restore), self-evolution
                (protected files, watchdog, evolver), SOUL and skills, Telegram
                channel, cron and heartbeat, onboarding and Mission Control,
                single-user cloud deployment, multi-tenant platform with Clerk
                auth, observability, identity system, git sync, and mobile
                responsive PWA.
              </p>

              <h3>5.3 SDK Decisions</h3>
              <p>
                Key decisions were verified through spike testing against the
                real SDK before commitment. V1 <code>query()</code> with{" "}
                <code>resume</code> was chosen over V2 because V2 silently drops
                critical options (MCP servers, agent definitions, system prompt).{" "}
                <code>allowedTools</code> was found to be auto-approve, not a
                filter: requiring use of <code>disallowedTools</code> for
                access control. <code>bypassPermissions</code> propagates to all
                sub-agents, necessitating PreToolUse hooks for fine-grained
                restrictions. Prompt caching (<code>cache_control</code>) on
                system prompt and tools yields 90% input cost savings on
                subsequent turns.
              </p>

              <h3>5.4 Project Structure</h3>
              <p>
                A pnpm monorepo with packages for the kernel, gateway, and
                platform. The shell is a Next.js 16 application. The{" "}
                <code>home/</code> directory is a file system template copied on
                first boot to <code>~/matrixos/</code>. Tests mirror the package
                structure. Specs live in numbered directories with task
                definitions.
              </p>
            </section>

            {/* --- 6. Web 4 Vision --- */}
            <section id="web4-vision">
              <h2>6. The Web 4 Vision</h2>
              <p>
                Every era of computing has unified previously separate things.
                Web 1 published static information. Web 2 created platforms for
                social interaction, but siloed identity and data across dozens of
                services. Web 3 attempted decentralization through
                cryptographic primitives but delivered complexity without
                improving the user experience.
              </p>
              <p>
                Web 4 is the unification. Operating system, messaging, social
                media, AI assistant, applications, games, and identity: all one
                thing. Not stitched together with APIs and OAuth tokens. Actually
                one thing.
              </p>

              <h3>6.1 Federated Identity</h3>
              <p>
                Every user receives two Matrix protocol identifiers:{" "}
                <code>@user:matrix-os.com</code> (the human) and{" "}
                <code>@user_ai:matrix-os.com</code> (their AI). These are
                globally unique, federated, and interoperable with any Matrix
                client. The human profile includes display name, social
                connections, preferences, and aggregated activity from connected
                platforms. The AI profile includes personality (from SOUL),
                skills, public activity, and a reputation score. Both are
                first-class citizens of the network.
              </p>

              <h3>6.2 AI-to-AI Communication</h3>
              <p>
                When one user&apos;s AI needs to coordinate with another&apos;s,
                they communicate directly via Matrix rooms with custom event
                types: meeting requests, data queries, task delegation. The AIs
                negotiate schedules, resolve conflicts, and confirm outcomes
                without human intervention. The human is notified of the result,
                not involved in the back-and-forth. End-to-end encryption ensures
                even the server operator cannot read AI-to-AI conversations.
              </p>
              <p>
                A security model based on the &quot;call center&quot; pattern
                governs external access: when an AI receives a message from
                another AI, it responds from a curated public context, not the
                owner&apos;s private files. The owner configures what their AI
                may share externally via a privacy configuration file.
              </p>

              <h3>6.3 Peer-to-Peer Sync</h3>
              <p>
                Matrix OS does not run on &quot;a computer.&quot; It runs on all
                of them. Laptop, desktop, phone, cloud server: all are peers.
                There is no primary or secondary. Git is the sync fabric for
                files. Matrix protocol is the sync fabric for conversations. A
                change made on the laptop appears on the phone. An app built on
                the desktop is accessible from the cloud. Conflict resolution is
                AI-assisted: the kernel reads git conflict markers and makes
                intelligent merge decisions.
              </p>

              <h3>6.4 Application Marketplace</h3>
              <p>
                Because applications are files, distribution is file sharing. An
                App Dev Kit provides bridge APIs, templates, and documentation.
                A marketplace enables browsing, installing, rating, and
                monetizing applications. Games are applications with multiplayer
                capabilities, leaderboards, and tournament scheduling. Revenue is
                shared between developer and platform.
              </p>
            </section>

            {/* --- 7. Evaluation --- */}
            <section id="evaluation">
              <h2>7. Evaluation</h2>

              <h3>7.1 What Works</h3>
              <p>
                The core thesis holds: an AI agent with full machine control can
                serve as an operating system kernel. Applications are generated
                from conversation and persisted as files. The shell discovers and
                renders them without prior knowledge. Self-healing detects and
                repairs failures. The same kernel is reachable from a web
                desktop and Telegram. Cron and heartbeat enable proactive
                behavior. SOUL produces consistent personality across channels.
                479 tests verify the implementation.
              </p>
              <p>
                The file-first architecture proves its value in sharing and
                backup. An application is a file you can email. The entire OS
                state is a folder you can copy. Git provides full version
                history. The absence of opaque state makes the system
                transparent and debuggable.
              </p>

              <h3>7.2 Limitations</h3>
              <p>
                <strong>Latency.</strong> Application generation takes seconds,
                not milliseconds. For pre-seed applications this is acceptable;
                for ad-hoc requests the delay is noticeable.{" "}
                <strong>Cost.</strong> Each kernel invocation consumes API
                tokens. Heavy usage can be expensive. Prompt caching mitigates
                this (90% savings on repeated system prompt content), but the
                fundamental cost of LLM inference remains.{" "}
                <strong>Determinism.</strong> LLM output is stochastic. The same
                request may produce different applications. For certain use
                cases (financial tools, safety-critical systems) this is
                unacceptable without additional verification.
              </p>
              <p>
                <strong>HTML application complexity.</strong> Single-file HTML
                applications work well for dashboards and simple tools but hit
                limits for complex applications that need databases, background
                processes, or heavy computation. The architecture supports full
                codebases via <code>~/projects/</code>, but the generation
                complexity is higher.{" "}
                <strong>Clerk form customization.</strong> The authentication UI
                (Clerk) has limited styling control, creating visual
                inconsistency with the surrounding design system.
              </p>

              <h3>7.3 Future Work</h3>
              <p>
                The novel paradigms (Living Software, Socratic Computing,
                Intent-Based Interfaces) are specified but not yet fully
                implemented. Full Matrix protocol federation (server-to-server,
                AI-to-AI messaging, cross-instance discovery) is designed but
                awaits implementation. The mobile experience is currently a
                responsive PWA; a native mobile app (Expo/React Native) and
                eventually an Android launcher are planned. Cost optimization
                through local model fallback (smaller models for routine tasks,
                Opus for complex reasoning) is a natural next step.
              </p>
            </section>

            {/* --- 8. Conclusion --- */}
            <section id="conclusion">
              <h2>8. Conclusion</h2>
              <p>
                Matrix OS demonstrates that an AI agent with full machine
                control, a file-first architecture, and a multi-channel gateway
                can serve as a complete operating system. The system generates
                real software from conversation, persists everything as files,
                heals itself, expands its own capabilities, and is reachable
                from any channel. The Web 4 vision extends this into a unified
                platform: operating system, messaging, social network, AI
                assistant, and marketplace, all under a single federated
                identity.
              </p>
              <p>
                The core insight is structural: the Claude Agent SDK already
                provides the primitives of an operating system: tool use is
                system calls, sub-agents are processes, the context window is
                RAM, the file system is disk. Matrix OS makes this mapping
                explicit and builds a complete system on top of it. The result is
                not an AI feature added to an OS, but an OS where AI is the
                fundamental computational substrate.
              </p>
              <p>
                This is Web 4: where software does not exist until you need it,
                and once it does, it is yours.
              </p>
            </section>

            {/* --- References --- */}
            <section id="references">
              <h2>References</h2>
              <ol className="text-sm">
                <li>
                  McIlroy, M.D., Pinson, E.N., Tague, B.A. &quot;UNIX
                  Time-Sharing System: Foreword.&quot;{" "}
                  <em>The Bell System Technical Journal</em>, 57(6), 1978.
                </li>
                <li>
                  Pike, R., Presotto, D., Dorward, S., et al. &quot;Plan 9 from
                  Bell Labs.&quot; <em>Computing Systems</em>, 8(3), 1995.
                </li>
                <li>
                  Kay, A.C. &quot;A Personal Computer for Children of All
                  Ages.&quot; <em>Proceedings of the ACM Annual Conference</em>,
                  1972.
                </li>
                <li>
                  Victor, B. &quot;Inventing on Principle.&quot;{" "}
                  <em>CUSEC 2012</em>. vimeo.com/36579366.
                </li>
                <li>
                  Victor, B. et al. <em>Dynamicland</em>. dynamicland.org,
                  2018-present.
                </li>
                <li>
                  Anthropic. &quot;Claude Agent SDK Documentation.&quot;{" "}
                  docs.anthropic.com, 2025.
                </li>
                <li>
                  Matrix.org Foundation. &quot;Matrix Specification.&quot;{" "}
                  spec.matrix.org, 2024.
                </li>
                <li>
                  Koza, J.R. <em>Genetic Programming</em>. MIT Press, 1992.
                </li>
                <li>
                  Maturana, H.R., Varela, F.J.{" "}
                  <em>Autopoiesis and Cognition: The Realization of the
                  Living</em>
                  . Reidel, 1980.
                </li>
                <li>
                  Yuan, J. <em>Mercury OS</em>. mercuryos.com, 2019.
                </li>
                <li>
                  Case, A. <em>Calm Technology</em>. O&apos;Reilly Media, 2015.
                </li>
                <li>
                  Bruner, J.S.{" "}
                  <em>Toward a Theory of Instruction</em>. Harvard University
                  Press, 1966.
                </li>
              </ol>
            </section>

            {/* Back to top */}
            <div className="mt-16 border-t border-border pt-8 print:hidden">
              <div className="flex items-center justify-between">
                <a
                  href="/"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  matrix-os.com
                </a>
                <a
                  href="#"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronUpIcon className="size-3.5" />
                  Back to top
                </a>
              </div>
            </div>
          </article>
        </div>
      </div>
    </>
  );
}
