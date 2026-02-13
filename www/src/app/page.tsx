import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  PlusIcon,
  HeartPulseIcon,
  MessageSquareIcon,
  UserIcon,
  ZapIcon,
  FolderOpenIcon,
  GithubIcon,
  ArrowRightIcon,
  SendIcon,
} from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <Nav />
      <Hero />
      <WhatIsThis />
      <Features />
      <Architecture />
      <Web4 />
      <Hackathon />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl flex items-center justify-between px-6 py-4">
        <span className="font-mono text-sm font-bold tracking-tight text-primary">
          matrix-os
        </span>
        <div className="flex items-center gap-6">
          <a
            href="https://github.com/HamedMP/matrix-os"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <a
            href="#hackathon"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Hackathon
          </a>
          <Button size="sm" asChild>
            <a href="#get-started">Get Started</a>
          </Button>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="relative pt-32 pb-24 px-6 overflow-hidden">
      <div className="relative mx-auto max-w-4xl text-center">
        <Badge
          variant="outline"
          className="mb-6 border-primary/30 bg-primary/10 text-primary font-mono text-xs tracking-widest uppercase"
        >
          Built with Opus 4.6
        </Badge>

        <h1 className="text-6xl sm:text-7xl md:text-8xl font-bold tracking-tight mb-6">
          Matrix{" "}
          <span className="text-primary">OS</span>
        </h1>

        <p className="text-xl sm:text-2xl text-muted-foreground mb-4 font-light">
          The Operating System That Builds Itself
        </p>

        <p className="text-base text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
          An AI-native operating system where software is generated in real time
          from conversation. You speak, applications materialize. The AI isn't a
          feature. It is the kernel.
        </p>

        <div className="flex items-center justify-center gap-4">
          <Button size="lg" asChild>
            <a href="#get-started">
              Get Started
              <ArrowRightIcon />
            </a>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a
              href="https://github.com/HamedMP/matrix-os"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GithubIcon />
              View Source
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

function WhatIsThis() {
  return (
    <section className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-3xl font-bold mb-8 text-center">
          What if software didn't exist until you needed it?
        </h2>
        <div className="space-y-6 text-muted-foreground leading-relaxed">
          <p>
            Every operating system you've ever used works the same way. Someone
            wrote the software before you touched it. They decided what it looks
            like. What it does. What you're allowed to change.
          </p>
          <p>
            Matrix OS starts from a different premise. You open it and see a
            clean surface. You tell it what you need, and the system writes it
            into existence -- real software, generated for you, saved as files
            you own.
          </p>
          <p>
            And it goes further. Matrix OS is your personal AI assistant, your
            messaging platform, your social network, and your game console --
            unified under one identity, one file system, one AI kernel. We call
            this{" "}
            <span className="text-primary font-semibold">Web 4</span>.
          </p>
        </div>
      </div>
    </section>
  );
}

const features = [
  {
    title: "Generate Apps from Conversation",
    description:
      'Say "I need an expense tracker" and a fully functional app appears on your desktop -- styled, persisted, ready to use.',
    icon: PlusIcon,
  },
  {
    title: "Self-Healing",
    description:
      "Break something? The OS detects the problem, diagnoses it, and repairs it. A dedicated healer agent monitors and fixes failures automatically.",
    icon: HeartPulseIcon,
  },
  {
    title: "Multi-Channel",
    description:
      "Talk to your OS from the web desktop, Telegram, WhatsApp, Discord, or Slack. Same kernel, same identity, same file system.",
    icon: MessageSquareIcon,
  },
  {
    title: "SOUL Identity",
    description:
      "Every instance has a personality defined in ~/system/soul.md. It shapes how the AI thinks, communicates, and acts. Your AI, your way.",
    icon: UserIcon,
  },
  {
    title: "Self-Expanding",
    description:
      "The OS writes its own capabilities. New agents, new skills, new tools -- all generated on demand by the evolver agent.",
    icon: ZapIcon,
  },
  {
    title: "Everything Is a File",
    description:
      "Apps, profiles, config, AI personality -- all files. Sync = git. Share = send a file. Backup = copy a folder. You always own your data.",
    icon: FolderOpenIcon,
  },
];

function Features() {
  return (
    <section className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold mb-4">What It Does</h2>
          <p className="text-muted-foreground">
            An operating system powered by Claude Opus 4.6 at the kernel level
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature) => (
            <Card
              key={feature.title}
              className="hover:shadow-md transition-shadow"
            >
              <CardHeader>
                <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-2">
                  <feature.icon className="w-5 h-5 text-primary" />
                </div>
                <CardTitle className="text-base">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent className="-mt-2">
                <CardDescription className="leading-relaxed">
                  {feature.description}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function Architecture() {
  const rows = [
    ["CPU", "Claude Opus 4.6"],
    ["RAM", "Agent context window"],
    ["Kernel", "Main agent + tools"],
    ["Processes", "Sub-agents (Task tool)"],
    ["Disk", "~/apps, ~/data, ~/system"],
    ["System calls", "Read, Write, Edit, Bash"],
    ["Device drivers", "MCP servers"],
    ["IPC", "File-based coordination"],
  ];

  return (
    <section className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-4xl">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold mb-4">The Core Metaphor</h2>
          <p className="text-muted-foreground">
            Claude Agent SDK as a literal operating system kernel
          </p>
        </div>

        <Card className="overflow-hidden p-0 gap-0">
          <div className="grid grid-cols-2 text-sm font-mono">
            <div className="px-5 py-3 border-b border-r border-border text-muted-foreground font-semibold uppercase tracking-wider text-xs">
              Computer
            </div>
            <div className="px-5 py-3 border-b border-border text-primary font-semibold uppercase tracking-wider text-xs">
              Matrix OS
            </div>

            {rows.map(([left, right], i) => (
              <Fragment key={left}>
                <div
                  className={`px-5 py-3 border-r border-border text-muted-foreground ${i < rows.length - 1 ? "border-b" : ""}`}
                >
                  {left}
                </div>
                <div
                  className={`px-5 py-3 text-foreground ${i < rows.length - 1 ? "border-b border-border" : ""}`}
                >
                  {right}
                </div>
              </Fragment>
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}

function Web4() {
  return (
    <section className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="text-3xl font-bold mb-4">Web 4</h2>
        <p className="text-muted-foreground mb-12 max-w-2xl mx-auto">
          Your operating system, messaging, social media, AI assistant, apps,
          games, and identity -- all one thing. Not stitched together with APIs.
          Actually one thing.
        </p>

        <Card className="text-left inline-block p-8">
          <div className="font-mono text-sm leading-relaxed">
            <div className="text-muted-foreground">Terminal (1970s)</div>
            <div className="text-muted-foreground ml-2">
              {"  -> "}Operating System (1980s)
            </div>
            <div className="text-muted-foreground ml-4">
              {"    -> "}GUI (1990s)
            </div>
            <div className="text-muted-foreground ml-6">
              {"      -> "}Web + Mobile (2000s)
            </div>
            <div className="text-muted-foreground ml-8">
              {"        -> "}AI Assistants (2020s)
            </div>
            <div className="text-primary font-bold ml-10">
              {"          -> "}Matrix OS / Web 4 (2026)
            </div>
            <div className="text-muted-foreground mt-4 ml-14 text-xs">
              Multi-channel + Multi-device + AI-powered
              <br />
              OS + Social + Messaging + Games + Agents
              <br />
              One identity, one file system, one AI kernel
            </div>
          </div>
        </Card>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
          {[
            {
              tag: "@you:matrix-os.com",
              title: "Federated Identity",
              desc: "Matrix protocol IDs. One handle, everywhere. Interoperable with any Matrix client.",
            },
            {
              tag: "AI-to-AI",
              title: "Agents Talk to Agents",
              desc: "Your AI negotiates with other AIs via Matrix rooms. E2E encrypted. No human in the loop.",
            },
            {
              tag: "git sync",
              title: "Every Device Is a Peer",
              desc: "Laptop, phone, cloud -- all peers. Git is the sync fabric. No central server required.",
            },
          ].map((item) => (
            <Card key={item.tag}>
              <CardHeader>
                <Badge
                  variant="outline"
                  className="w-fit border-primary/30 bg-primary/10 text-primary font-mono text-xs"
                >
                  {item.tag}
                </Badge>
                <CardTitle className="text-base">{item.title}</CardTitle>
              </CardHeader>
              <CardContent className="-mt-2">
                <CardDescription>{item.desc}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function Hackathon() {
  return (
    <section
      id="hackathon"
      className="py-24 px-6 border-t border-border"
    >
      <div className="mx-auto max-w-3xl text-center">
        <Badge
          variant="outline"
          className="mb-6 border-primary/30 bg-primary/10 text-primary font-mono text-xs tracking-widest uppercase"
        >
          Anthropic Hackathon -- Feb 2026
        </Badge>

        <h2 className="text-3xl font-bold mb-6">Built with Opus 4.6</h2>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          Matrix OS is being built for the{" "}
          <a
            href="https://cv.inc/e/claude-code-hackathon"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Anthropic "Built with Opus 4.6" Hackathon
          </a>
          . The entire system -- from kernel to shell to this landing page -- is
          built with Claude Code and the Claude Agent SDK.
        </p>

        <Card className="text-left mb-10">
          <CardContent className="pt-6">
            <blockquote className="border-l-2 border-primary pl-5">
              <p className="text-sm text-muted-foreground italic leading-relaxed">
                "This is Matrix OS. It's not just an AI assistant and it's not
                just an operating system. It's both. And it's also your social
                network, your messaging platform, and your game console. Watch
                me build an app by speaking. Watch me message it from Telegram.
                Watch two AIs negotiate a meeting. One identity. One platform.
                Every device. This is Web 4."
              </p>
            </blockquote>
          </CardContent>
        </Card>

        <Card id="get-started">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Try Matrix OS</CardTitle>
            <CardDescription>
              Sign up to get your own Matrix OS instance. Build apps, connect
              channels, customize your AI.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col sm:flex-row items-center gap-3 max-w-md mx-auto">
              <Input
                type="email"
                placeholder="you@example.com"
                className="bg-background"
              />
              <Button type="submit" className="w-full sm:w-auto whitespace-nowrap">
                <SendIcon />
                Join Waitlist
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="py-12 px-6 border-t border-border">
      <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-4">
        <span className="font-mono text-sm text-muted-foreground">
          matrix-os.com
        </span>
        <div className="flex items-center gap-6 text-sm text-muted-foreground">
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
        <span className="text-xs text-muted-foreground">
          Built with Claude Opus 4.6
        </span>
      </div>
    </footer>
  );
}
