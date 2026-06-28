export type SolutionPage = {
  slug: string;
  eyebrow: string;
  title: string;
  metaTitle: string;
  description: string;
  audience: string;
  problem: string;
  answer: string;
  outcomes: string[];
  workflows: string[];
  proofPoints: string[];
  ctaLabel: string;
  ctaHref: string;
  related: string[];
};

export const solutionPages = [
  {
    slug: "cloud-computer-for-ai-agents",
    eyebrow: "Cloud computer",
    title: "A computer in the cloud for AI agents",
    metaTitle: "Cloud Computer for AI Agents | Matrix OS",
    description:
      "Matrix OS gives AI agents a private cloud computer with files, terminals, apps, previews, workflows, memory, and connected tools.",
    audience: "Developers, builders, founders, and professionals who want AI agents to do real work instead of only chat.",
    problem:
      "Most AI agents still depend on a local laptop. When the laptop sleeps, the browser tab closes, or the terminal disconnects, the work stops.",
    answer:
      "Matrix gives the agent its own always-on hosted computer. Humans connect from any device, but the work, files, sessions, apps, and context stay in Matrix.",
    outcomes: [
      "Keep agent sessions running after your laptop closes",
      "Use terminals, files, apps, previews, and workflows in one workspace",
      "Attach from a browser, the Matrix CLI, or a teammate's device",
      "Centralize context so agents can continue work without repeated setup",
    ],
    workflows: [
      "Clone a repo, run tests, and keep the preview online",
      "Run Hermes or an OpenClaw-style agent against connected tools",
      "Create a dashboard, tracker, report, or internal app",
      "Review files and terminal logs from any screen",
    ],
    proofPoints: [
      "Private hosted Matrix computer per user",
      "Persistent named terminal sessions",
      "Region and power selection during signup",
      "Owner-controlled files and workspace data",
    ],
    ctaLabel: "Start your cloud computer",
    ctaHref: "https://app.matrix-os.com",
    related: ["ai-coding-agents-cloud-workspace", "hermes-ai-agent-hosting", "professional-ai-assistant-cloud-computer"],
  },
  {
    slug: "ai-coding-agents-cloud-workspace",
    eyebrow: "Coding agents",
    title: "Use all your coding agents in one cloud workspace",
    metaTitle: "Cloud Workspace for AI Coding Agents | Matrix OS",
    description:
      "Run Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, and other coding agents inside an always-on Matrix cloud computer.",
    audience: "Developers who want autonomous coding agents to run terminals, previews, tests, and PR workflows without occupying a local machine.",
    problem:
      "AI coding tools are powerful, but local development is fragile for autonomous work. Agents need repos, shells, auth, previews, logs, and time.",
    answer:
      "Matrix gives each agent a persistent terminal and cloud workspace. Bring your preferred coding agents, sign in through their own browser/device flows, and keep the work running in Matrix.",
    outcomes: [
      "Run Claude, Codex, Cursor, OpenCode, Pi, Gemini CLI, and terminal agents",
      "Keep tests, previews, and long-running sessions alive",
      "Review work through visible files, logs, diffs, and PRs",
      "Move between browser, CLI, Mac, iOS, or a teammate's screen",
    ],
    workflows: [
      "Ask Codex to refactor a feature while Claude reviews docs",
      "Run OpenCode or Cursor inside the Matrix shell",
      "Use GitHub auth inside Matrix, clone the repo, and open a PR",
      "Reattach to the same named session later",
    ],
    proofPoints: [
      "Matrix CLI and web shell",
      "Safe setup prompt and Matrix skill",
      "Persistent terminal sessions",
      "Cloud previews and reviewable diffs",
    ],
    ctaLabel: "Read developer quickstart",
    ctaHref: "/docs/quickstart",
    related: ["cloud-computer-for-ai-agents", "autonomous-coding-cloud-development", "enterprise-ai-coding-lab"],
  },
  {
    slug: "autonomous-coding-cloud-development",
    eyebrow: "Autonomous coding",
    title: "Cloud-native development for autonomous coding",
    metaTitle: "Autonomous Coding in the Cloud | Matrix OS",
    description:
      "Matrix OS lets autonomous coding agents run in a cloud-native development environment with persistent shells, previews, tests, and review loops.",
    audience: "Engineering teams and solo builders moving from autocomplete to agents that can plan, build, test, and open pull requests.",
    problem:
      "Autonomous coding is not a text-editor problem. It is an environment problem: agents need a durable place to execute work.",
    answer:
      "Matrix turns the development environment into an always-on computer. Symphony coordinates parallel sessions, while the shell keeps agent work visible and reviewable.",
    outcomes: [
      "Run multiple agent sessions in parallel",
      "Keep work visible instead of hidden in isolated chat threads",
      "Review tests, terminal output, previews, and diffs before merging",
      "Let agents continue while humans are offline",
    ],
    workflows: [
      "Queue a feature, docs update, and test pass across separate sessions",
      "Leave a long-running migration or e2e test open in Matrix",
      "Review an agent's branch from the browser shell",
      "Hand off a session to a teammate without losing context",
    ],
    proofPoints: [
      "Symphony orchestration layer",
      "Named Matrix sessions",
      "Browser desktop and CLI attach",
      "PR-oriented review workflow",
    ],
    ctaLabel: "Start cloud dev",
    ctaHref: "https://app.matrix-os.com",
    related: ["ai-coding-agents-cloud-workspace", "remote-development-workspace", "enterprise-ai-coding-lab"],
  },
  {
    slug: "hermes-ai-agent-hosting",
    eyebrow: "Hermes",
    title: "Easy hosting for Hermes and Matrix-native agents",
    metaTitle: "Hermes AI Agent Hosting | Matrix OS",
    description:
      "Host Hermes in Matrix OS so it has a persistent computer for workflows, connected tools, approvals, notifications, and memory.",
    audience: "Teams and professionals who want an AI agent that can use real tools, run recurring workflows, and keep context in one place.",
    problem:
      "An assistant that only answers questions cannot operate a workflow. Hermes needs a place to run, remember, connect tools, and ask for approval.",
    answer:
      "Matrix gives Hermes an always-on hosted computer with connected tools, files, apps, schedules, and the Matrix skill pack.",
    outcomes: [
      "Run Hermes as the Matrix-native workflow agent",
      "Connect GitHub, Linear, Slack, Gmail, Calendar, Drive, and Matrix apps",
      "Use approvals before sensitive actions",
      "Keep workflows running without managing servers",
    ],
    workflows: [
      "Turn Discord feedback into Linear tasks",
      "Prepare weekly research briefs from connected tools",
      "Create dashboards, trackers, and internal apps",
      "Send notifications and ask for approval when needed",
    ],
    proofPoints: [
      "Hermes remains available alongside Claude and Codex",
      "Matrix skill pack for agent setup",
      "Hosted runtime with persistent files and sessions",
      "Platform-owned integration credentials",
    ],
    ctaLabel: "Talk about Hermes hosting",
    ctaHref: "/contact?audience=hermes-hosting",
    related: ["professional-ai-assistant-cloud-computer", "cloud-computer-for-ai-agents", "openclaw-agent-cloud-computer"],
  },
  {
    slug: "openclaw-agent-cloud-computer",
    eyebrow: "OpenClaw-style agents",
    title: "A cloud computer for OpenClaw-style AI agents",
    metaTitle: "Cloud Computer for OpenClaw-Style Agents | Matrix OS",
    description:
      "Matrix OS gives OpenClaw-style agents a durable cloud workspace for tools, files, terminals, channels, and human approvals.",
    audience: "Builders who like the OpenClaw agent model and want a hosted computer where assistants can operate across tools and channels.",
    problem:
      "Channel-native agents need more than a chat thread. They need durable files, workflows, integrations, and a runtime that is always reachable.",
    answer:
      "Matrix builds on the cloud-computer pattern: agents can work through shell, apps, messages, tools, and skills while humans stay in control.",
    outcomes: [
      "Give OpenClaw-style agents a persistent workspace",
      "Move from chat responses to real workflows",
      "Keep files, prompts, tools, and approvals visible",
      "Use a hosted Matrix computer instead of stitching together local scripts",
    ],
    workflows: [
      "Route channel requests into a Matrix workflow",
      "Create apps and reports from messages and files",
      "Use Hermes for Matrix-native assistant work",
      "Keep agent memory and artifacts in the same workspace",
    ],
    proofPoints: [
      "Technical heritage from OpenClaw documented on Matrix",
      "Multi-shell vision across web, chat, CLI, and apps",
      "Files and skills as inspectable agent context",
      "Hosted cloud computer for agent execution",
    ],
    ctaLabel: "Explore technical roots",
    ctaHref: "/technical",
    related: ["hermes-ai-agent-hosting", "cloud-computer-for-ai-agents", "professional-ai-assistant-cloud-computer"],
  },
  {
    slug: "enterprise-ai-coding-lab",
    eyebrow: "Enterprise AI labs",
    title: "AI coding experiments away from managed laptops",
    metaTitle: "Enterprise AI Coding Lab in the Cloud | Matrix OS",
    description:
      "Give enterprise developers isolated Matrix cloud computers for AI coding experiments when security policy blocks local installs.",
    audience: "Companies where developers want to try the latest coding agents but IT policy restricts local tools, browser handoffs, or unmanaged credentials.",
    problem:
      "Enterprise developers want to test Claude, Codex, Cursor, OpenCode, and new AI tools, but managed laptops often cannot install or run them freely.",
    answer:
      "Matrix gives each pilot user an isolated hosted computer. The experiments happen in the Matrix workspace instead of on the corporate laptop.",
    outcomes: [
      "Evaluate AI coding tools without changing local laptop policy",
      "Separate experiments from corporate machine configuration",
      "Choose region, power, and pilot scope",
      "Give security and engineering a clearer boundary",
    ],
    workflows: [
      "Provision pilot workspaces for an AI lab",
      "Run coding agents against test repos and prototypes",
      "Review terminal logs, previews, and PRs",
      "Document rollout constraints before wider adoption",
    ],
    proofPoints: [
      "Hosted cloud computer per pilot user",
      "Guided enterprise contact path",
      "CLI, docs, and skill onboarding",
      "No local credential migration required by default",
    ],
    ctaLabel: "Plan an enterprise pilot",
    ctaHref: "/contact?audience=enterprise",
    related: ["ai-coding-agents-cloud-workspace", "autonomous-coding-cloud-development", "university-ai-development-lab"],
  },
  {
    slug: "university-ai-development-lab",
    eyebrow: "Universities",
    title: "Cloud labs for AI-native software courses",
    metaTitle: "University AI Development Labs | Matrix OS",
    description:
      "Matrix OS provides repeatable cloud computers for university courses, workshops, hackathons, and AI-native software labs.",
    audience: "Universities, labs, bootcamps, and workshops that need consistent development environments for students and researchers.",
    problem:
      "Local setup slows down courses and hackathons. Different laptops, permissions, operating systems, and toolchains create avoidable support load.",
    answer:
      "Matrix gives each participant a hosted cloud computer with the same shell, files, agents, docs, and workflows.",
    outcomes: [
      "Reduce local setup drift across cohorts",
      "Let students use modern AI coding agents safely",
      "Run labs from shared, locked-down, or personal devices",
      "Keep course context and artifacts in one workspace",
    ],
    workflows: [
      "Provision a lab environment before class",
      "Run Claude, Codex, OpenCode, or Hermes inside Matrix",
      "Clone starter repos and keep previews online",
      "Use Matrix docs and skills for guided onboarding",
    ],
    proofPoints: [
      "Repeatable hosted workspaces",
      "Works from browser and CLI",
      "Guided university pilot path",
      "Standardized developer onboarding",
    ],
    ctaLabel: "Plan a university pilot",
    ctaHref: "/contact?audience=university",
    related: ["enterprise-ai-coding-lab", "ai-coding-agents-cloud-workspace", "remote-development-workspace"],
  },
  {
    slug: "professional-ai-assistant-cloud-computer",
    eyebrow: "Professional assistant",
    title: "An AI assistant with its own cloud computer",
    metaTitle: "Professional AI Assistant Cloud Computer | Matrix OS",
    description:
      "Use Matrix OS as an always-on computer for professional AI assistants that handle research, meeting prep, follow-ups, docs, dashboards, and tools.",
    audience: "Professionals who want an assistant that can operate across real tools, not just answer questions in chat.",
    problem:
      "Generic AI companions forget context, cannot keep tools open, and usually cannot run recurring work without a human babysitting every step.",
    answer:
      "Matrix gives Hermes and other assistants a persistent workspace for files, apps, tools, schedules, approvals, and memory.",
    outcomes: [
      "Prepare meetings with context from connected tools",
      "Draft follow-ups, reports, research briefs, and dashboards",
      "Keep recurring workflows running in a hosted workspace",
      "Centralize context instead of spreading it across apps",
    ],
    workflows: [
      "Prepare me for tomorrow's investor meeting",
      "Draft replies for important emails and wait for approval",
      "Create a weekly operating dashboard",
      "Research competitors and save a structured report",
    ],
    proofPoints: [
      "Hermes as the Matrix-native assistant",
      "Connected tool workflows",
      "Approval-oriented actions",
      "Persistent files, memory, and apps",
    ],
    ctaLabel: "Discuss assistant workflows",
    ctaHref: "/contact?audience=professional-assistant",
    related: ["hermes-ai-agent-hosting", "cloud-computer-for-ai-agents", "openclaw-agent-cloud-computer"],
  },
  {
    slug: "remote-development-workspace",
    eyebrow: "Remote development",
    title: "A remote development workspace that stays awake",
    metaTitle: "Remote Development Workspace for AI Agents | Matrix OS",
    description:
      "Matrix OS is a hosted remote development workspace for humans and AI agents, with persistent terminals, previews, files, and workflows.",
    audience: "Developers who work across laptops, phones, browsers, and teammates while needing the development environment to stay online.",
    problem:
      "Remote development often still depends on a local laptop staying awake, a tunnel staying open, or a single terminal session not being interrupted.",
    answer:
      "Matrix keeps the computer in the cloud. Your devices become viewers while the actual work continues inside Matrix.",
    outcomes: [
      "Work from anywhere without keeping a laptop awake",
      "Share a running workspace with teammates",
      "Keep previews, terminals, and agents online",
      "Centralize repo context, logs, and generated artifacts",
    ],
    workflows: [
      "Continue work from a browser after leaving your laptop",
      "Let an agent run e2e tests while you travel",
      "Show a teammate the running shell and preview",
      "Keep project context in one Matrix workspace",
    ],
    proofPoints: [
      "Browser desktop and CLI attach",
      "Persistent terminal sessions",
      "Always-on hosted Matrix computer",
      "Mac and iOS apps planned",
    ],
    ctaLabel: "Start remote cloud dev",
    ctaHref: "https://app.matrix-os.com",
    related: ["cloud-computer-for-ai-agents", "autonomous-coding-cloud-development", "ai-coding-agents-cloud-workspace"],
  },
] as const satisfies SolutionPage[];

export type SolutionSlug = (typeof solutionPages)[number]["slug"];

export function getSolution(slug: string) {
  return solutionPages.find((page) => page.slug === slug);
}
