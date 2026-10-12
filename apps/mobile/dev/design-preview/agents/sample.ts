import type { AgentListRow } from "@/components/agents/agent-rows";
import type { AgentTemplate } from "@/components/agents/agent-templates";

// Frame A1's four agents. The frame's fourth row says "Paused", a state the
// server does not have, so that row shows a description instead.
export const SAMPLE_AGENT_ROWS: AgentListRow[] = [
  {
    id: "account-research",
    name: "Account research",
    category: "sales",
    tone: "waiting",
    subtitle: "Waiting for your approval",
    time: "2m",
  },
  {
    id: "my-inbox",
    name: "My inbox",
    category: "productivity",
    tone: "active",
    subtitle: "3 drafts ready to review",
    time: "9:12",
  },
  {
    id: "competitor-watch",
    name: "Competitor watch",
    category: "research",
    tone: "active",
    subtitle: "Reading sources…",
    time: "now",
  },
  {
    id: "launch-tracker",
    name: "Launch tracker",
    category: "operations",
    tone: null,
    subtitle: "Tracks what is left before launch",
    time: "Mon",
  },
];

/** The number on the Agents tab in frame A1. */
export const SAMPLE_WAITING_COUNT = 2;

// Frame A5's five templates, without "Start from scratch".
export const SAMPLE_TEMPLATES: AgentTemplate[] = [
  {
    recipeId: "inbox-triage",
    version: "sample",
    name: "Inbox triage",
    description: "Sorts your inbox and drafts replies",
    category: "productivity",
  },
  {
    recipeId: "daily-planner",
    version: "sample",
    name: "Daily planner",
    description: "Plans your day around meetings",
    category: "productivity",
  },
  {
    recipeId: "account-research",
    version: "sample",
    name: "Account research",
    description: "Briefs you before every sales call",
    category: "sales",
  },
  {
    recipeId: "competitor-watch",
    version: "sample",
    name: "Competitor watch",
    description: "Tells you when competitors change",
    category: "research",
  },
  {
    recipeId: "meeting-follow-up",
    version: "sample",
    name: "Meeting follow-up",
    description: "Turns notes into owners and next steps",
    category: "operations",
  },
];

/** The template whose setup sheet frame A5b shows. */
export const SAMPLE_SETUP_TEMPLATE = SAMPLE_TEMPLATES[2];
