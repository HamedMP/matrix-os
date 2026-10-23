# Homepage Messaging Review Worksheet

Purpose: review homepage messaging one sentence or label at a time before changing `www`.

Status legend:

- `pending`: needs Hamed review
- `approved`: safe to implement
- `rewrite`: needs a new draft
- `reject`: do not implement

## Review Rules

- Do not batch homepage copy changes without explicit approval.
- Preserve the broad use-case showcase and solution catalog.
- Keep developer/cloud-coding as the entry wedge, but do not erase business workflows, workshops, hackathons, universities, Hermes, or company-brain use cases.
- For every approved change, implement only the approved sentence/label and keep the diff small.

## Metadata

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | Page title | Matrix OS - A cloud computer for background AI agents | Matrix OS - Task-first cloud coding for AI agents | Narrows the first impression toward developer PLG. | pending |  |
| M2 | Meta description | Matrix gives background agents their own computer. Run Claude, Codex, Cursor, OpenCode, and Hermes in a private hosted workspace with persistent terminals, repos, previews, and workflows that keep going after your laptop closes. | Matrix gives developers and teams a private cloud computer for task-first coding with AI agents, persistent terminals, repos, previews, workflows, and sessions that keep going after your laptop closes. | Makes the developer/team cloud-coding wedge explicit while preserving persistent-agent language. | pending |  |

## Hero

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | Hero headline line 1 | A computer in the cloud | Task-first cloud coding | More concrete for developers, but may be less iconic than the current line. | pending |  |
| H2 | Hero headline line 2 | for your AI agents | for AI agents | Slightly shorter; may lose ownership/personality from "your". | pending |  |
| H3 | Hero body sentence 1 | Run Claude, Codex, Cursor, and Hermes as background agents on one private hosted computer. | Give every task its own cloud worktree, terminal sessions, previews, files, logs, and agent runs. | Explains task-first cloud coding concretely. | pending |  |
| H4 | Hero body sentence 2 | Terminals, repos, previews, and workflows that keep going after your laptop closes. | Your laptop becomes a viewer; the coding work keeps going in Matrix. | Makes the local-device vs cloud-computer model sharper. | pending |  |
| H5 | Hero helper text sentence 1 | Free to sign up. | Free to sign up. | No change proposed. | approved |  |
| H6 | Hero helper text sentence 2 | Or copy the prompt into Claude Code, Codex, or Cursor and your agent sets Matrix up for you. | Or copy the prompt into your coding agent and let it set up your Matrix cloud computer for you. | Avoids over-indexing on named tools in helper text. | pending |  |

## Platform Grid

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Section title | The always-on computer for background agents. | The cloud computer behind the task. | Makes task the primary product object. | pending |  |
| P2 | Section continuation | You set the direction. Agents keep working while your devices sleep. | You set the direction. Matrix keeps the terminals, previews, files, and agents alive. | More concrete artifacts, less generic background-agent phrasing. | pending |  |
| P3 | Feature title | Background agents | Tasks own the workspace | Makes task-first architecture explicit. | pending |  |
| P4 | Feature description | Task in, reviewed change out. Agents keep coding on their own computer long after you close the laptop. | Each task carries the repo, worktree, terminal sessions, previews, logs, diffs, and agent runs needed to finish it. | Defines what a task owns. | pending |  |
| P5 | Feature title | Every coding agent, one computer | Every coding agent, one cloud computer | Minor clarity tweak. | pending |  |
| P6 | Feature description | Claude, Codex, Cursor, OpenCode, Pi, and Gemini CLI in persistent sessions with repos, tests, and previews. | Bring terminal-first coding agents into persistent cloud sessions with repos, tests, credentials, and previews. | Generalizes the agent list and adds credentials. | pending |  |
| P7 | Feature title | Hermes, the resident agent | Hermes, the resident agent | No change proposed. | approved |  |
| P8 | Feature description | A Matrix-native agent for connected tools, scheduled workflows, notifications, and approvals. | The expansion path: background business agents connected to tools, schedules, approvals, logs, and company context. | Connects Hermes to business/company-brain strategy. | pending |  |

## Use-Case Showcase

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| U1 | Showcase heading sentence 1 | What you can hand to your agents. | What you can hand to your agents. | No change proposed after your feedback. | approved |  |
| U2 | Showcase heading sentence 2 | Real tasks, running in the background on your Matrix computer. | Coding tasks, review chores, incidents, and business workflows running on your Matrix computer. | Keeps broad use cases while making developer and business workflows explicit. | pending |  |
| U3 | Showcase item | Fix bugs from Linear | Fix bugs from Linear | No change proposed. | approved |  |
| U4 | Showcase item | Verify merged changes | Verify merged changes | No change proposed. | approved |  |
| U5 | Showcase item | Summarize CI failures | Summarize CI failures | No change proposed. | approved |  |
| U6 | Showcase item | Triage Sentry errors | Triage Sentry errors | No change proposed. | approved |  |
| U7 | Showcase item | Patch vulnerable deps | Patch vulnerable deps | No change proposed. | approved |  |
| U8 | Showcase item | Draft release notes | Draft release notes | No change proposed. | approved |  |
| U9 | Showcase item | Pick up backlog work | Pick up backlog work | No change proposed. | approved |  |
| U10 | Showcase item | Turn Discord feedback into Linear tasks | Turn Discord feedback into Linear tasks | No change proposed. | approved |  |

## Symphony

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Section title | Symphony orchestrates the work. | Symphony turns tasks into cloud workspaces. | Makes Symphony's role more specific. | pending |  |
| S2 | Section continuation | Assign tasks, run agents in parallel, review only what survives. | Assign work, run agents in terminals, review only what survives. | Emphasizes terminal-first execution. | pending |  |
| S3 | Point title | Run agents in parallel | Start from the task | Changes from agent-centric to task-centric. | pending |  |
| S4 | Point description | Split work across Claude, Codex, Cursor, OpenCode, or Gemini CLI sessions without blocking your laptop. | Create the task, attach the repo and worktree, then launch the terminal sessions and agent CLIs in the right context. | Describes the workflow more concretely. | pending |  |
| S5 | Point title | See status at a glance | Keep every session visible | Moves from generic status to terminal/session visibility. | pending |  |
| S6 | Point description | Track what each agent is reading, editing, testing, previewing, and waiting on before you review. | Track what each terminal is running, which agent is active, what preview is live, and what needs human input. | Surfaces terminal, preview, and needs-input concepts. | pending |  |
| S7 | Point title | Merge what survives review | Ship only reviewed changes | Slightly more active phrasing. | pending |  |
| S8 | Point description | Keep human control over branches, diffs, checks, browser previews, and PRs. | Keep human control over branches, diffs, checks, browser previews, commits, and PRs. | Adds commits as a human-confirmed step. | pending |  |
| S9 | Queue row | Hermes: Turn Discord feedback into Linear tasks | Hermes: Prepare release follow-ups | Avoids duplicating Discord/Linear from showcase, but may weaken the broad workflow story. | pending |  |

## Hermes

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| HE1 | Section headline | The resident agent for everything around the code | The resident agent for company workflows | Broadens Hermes beyond developer-adjacent work. | pending |  |
| HE2 | Body sentence 1 | Coding agents build software. | Coding is the first wedge. | Connects GTM sequencing to product story, but may be too inside-baseball for homepage. | pending |  |
| HE3 | Body sentence 2 | Hermes runs the operating system around them: tool connections, scheduled workflows, notifications, approvals, memory, and everyday actions. | Hermes is the broader operating layer: connected tools, scheduled workflows, notifications, approvals, memory, and everyday business actions. | Positions Hermes as the business-agent expansion path. | pending |  |
| HE4 | Card title | Build workflows | Run background jobs | More concrete operational language. | pending |  |
| HE5 | Card description | Turn recurring product, support, finance, and engineering work into Matrix workflows that run on schedule. | Turn recurring product, support, finance, and engineering work into scheduled Matrix workflows with logs and approvals. | Adds logs and approvals as trust features. | pending |  |
| HE6 | Card title | Connect every tool | Connect the company brain | Ties to company-brain narrative. | pending |  |
| HE7 | Card description | Work across GitHub, Linear, Slack, Discord, Gmail, Calendar, Drive, Sentry, Datadog, billing, and Matrix apps. | Work across GitHub, Linear, Slack, Gmail, Calendar, Drive, Sentry, Datadog, billing, and Matrix apps. | Removes Discord by accident; likely reject. | reject | Keep current unless you want a different list. |
| HE8 | Card title | Ship apps and automations | Operate through UI, CLI, and RPC | More platform/control-plane language. | pending |  |
| HE9 | Card description | Create internal tools, dashboards, trackers, reports, and app workflows in the same Matrix workspace. | Give teams a real control surface for agents, jobs, schedules, tool permissions, run history, and handoffs. | Focuses on governance/control rather than outputs. | pending |  |

## Pilot Band

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Pilot sentence | Running an enterprise evaluation, university pilot, or Hermes hosting rollout? | Running a team rollout, workshop, hackathon, university lab, or Hermes hosting pilot? | Adds workshops/hackathons/team rollout, per your strategy. | pending |  |

## Final CTA

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | CTA headline | Move your agents off your laptop | Start with one task in the cloud | More task-first, but current copy may be punchier. | pending |  |
| C2 | CTA body sentence 1 | Start with one cloud workspace. | Create a private Matrix computer, attach a repo, launch your agent in a terminal, and keep the whole task alive across every screen. | Makes the workflow concrete. | pending |  |
| C3 | CTA body sentence 2 | Add agents, tools, workflows, and teammates as the work grows. | Included in proposed C2 replacement. | I collapsed the expansion story into the workflow sentence; may be worse. | pending |  |

## FAQ

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Existing FAQ question | Is Matrix another AI editor? | Is Matrix another AI editor? | No change proposed. | approved |  |
| F2 | Existing FAQ answer | No. Matrix is the always-on cloud computer where coding agents get repos, terminals, previews, files, auth, and review loops that keep running after your laptop closes. | No. Matrix is the always-on cloud computer where coding agents get repos, terminals, previews, files, auth, and review loops that keep running after your laptop closes. | No change proposed. | approved |  |
| F3 | New FAQ question | None | What does task-first cloud coding mean? | Adds an explicit definition for the new category language. | pending |  |
| F4 | New FAQ answer | None | A task owns the cloud worktree, terminal sessions, previews, logs, diffs, agent runs, and handoff state needed to finish it. You can leave, reconnect, or share the task without rebuilding context. | Defines the product model. | pending |  |
| F5 | Existing FAQ question | Which agents can I use? | Which agents can I use? | No change proposed. | approved |  |
| F6 | Existing FAQ answer | Bring Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, and terminal agents. Matrix also hosts Matrix-native agents like Hermes and OpenClaw-style assistants for workflows and connected tools. | Bring Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, and terminal agents. Matrix also hosts Matrix-native agents like Hermes and OpenClaw-style assistants for workflows and connected tools. | Restored after your feedback. | approved |  |
| F7 | Existing FAQ question | What is Symphony? | What is Symphony? | No change proposed. | approved |  |
| F8 | Existing FAQ answer | Symphony is the Matrix orchestration layer for autonomous coding: parallel sessions, task queues, terminal runs, previews, PR review, and handoff between agents and humans. | Symphony is the Matrix orchestration layer for cloud coding: task workspaces, parallel terminal sessions, agent runs, previews, PR review, and handoff between agents and humans. | Makes task workspaces explicit. | pending |  |
| F9 | Existing FAQ question | What is Hermes? | What is Hermes? | No change proposed. | approved |  |
| F10 | Existing FAQ answer | Hermes is the Matrix-native agent for workflows and connected tools. It can work across GitHub, Linear, Slack, Gmail, Calendar, Drive, billing, settings, and Matrix apps with your permission. | Hermes is the Matrix-native agent for background company workflows. It can work across connected tools, schedules, approvals, logs, and Matrix apps with your permission. | Makes Hermes more company-agent oriented; loses the concrete tool list. | pending |  |

## Header Navigation

| ID | Surface | Current copy | Proposed copy | Why I proposed it | Status | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | Platform menu, Symphony description | Background coding agents, orchestrated | Task-first cloud coding workspaces | Sharper developer wedge. | pending |  |
| N2 | Platform menu, Hermes description | The resident agent for everything else | Background agents for company workflows | More explicit business use case. | pending |  |
| N3 | Platform featured card | Agents that keep working after your laptop closes | Tasks, terminals, agents, and previews that stay alive | More concrete artifacts. | pending |  |
| N4 | Use cases menu, all use cases description | Where background agents go to work | Where task-first cloud work starts | More task-first, but may narrow too much. | pending |  |
| N5 | Use cases menu, developers description | Coding agents with a real computer | Agent CLIs with a real cloud computer | More terminal/CLI specific. | pending |  |
| N6 | Use cases menu, universities description | Repeatable labs for AI-native courses | Repeatable labs, workshops, and hackathons | Adds workshop/hackathon use case. | pending |  |
| N7 | Use cases featured card | What you can hand to your agents today | What your cloud task workspace should include | More task-workspace oriented, but less broad. | pending |  |
| N8 | Featured terminal mock line | fix bugs from Linear | work on task checkout-117 | Makes task object visible, but loses concrete integration. | pending |  |

## Alternative Copy Bank

Use this area to collect rewrites before implementation.

| ID | Candidate copy | Notes |
| --- | --- | --- |
| ALT1 | A cloud computer for every coding task | Possible hero headline. |
| ALT2 | Stop running coding agents on your laptop | Strong developer wedge, maybe too negative. |
| ALT3 | Your AI agents need a computer that stays awake | Keeps the iconic cloud-computer message. |
| ALT4 | Matrix gives every task a persistent cloud workspace: terminals, files, previews, logs, diffs, and agent runs included. | Possible hero body. |
| ALT5 | From coding tasks to business workflows, Matrix gives agents a real place to work. | Bridges developer and Ona-style use cases. |
