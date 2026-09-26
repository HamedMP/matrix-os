# Recipe Capability and Acceptance Map

Baseline: all 71 metadata entries in `packages/ui/src/chat-agents/agent-inspirations.generated.ts`, plus Jev from `AgentRecipesPanel.tsx`, at Matrix `5f9fc5362` (2026-09-26). This is a proposed qualification map, not a statement that these capabilities work today.

Every row starts **not tested** for the proposed Pi runtime. Human-readable skill names are metadata, not installed executable skills. Build original Matrix procedures; preserve provenance without copying private prompts. A follow-up must replace each proposed scenario with concrete input fixtures, exact required connector actions/application access, observable outcomes, and actual evidence.

Routines listed in the source remain suggestions until the user activates them in conversation. Some source entries have no skills or integrations; missing metadata is not proof that the workflow needs no tools. The initial spike covers representative families only.

## Capability Families

| Family | Required substrate |
|---|---|
| Research and monitoring | Search/browser, evidence extraction, dated citations; persistent profiles for authenticated sources |
| Connected operations | Scoped connectors or browser, account choice, structured records, approved writes and shared-output grants |
| Analysis and finance | Scoped source data, calculations/spreadsheets, evidence checks; explicit approval for monetary/account changes |
| Writing and personal memory | Scoped preference memory, source reading, editable text artifacts; no implied access to personal records |
| Design and artifacts | Visual understanding, document/slide rendering, Figma or application access as relevant; generation tools where needed |
| Media | Media intake, transcription, FFmpeg/editing, rendered playback and export verification |
| Engineering | Isolated code/commands, Git, tests, browser/desktop checks, reviewed artifacts |
| Agent coordination | Participant/task management, bounded delegation, explicit creation/grant authority |
| Specialist external execution | Explicit telephony or supported device adapter; recipient/device scope and observed external outcome |

## Complete Marketplace Inventory

| Recipe | Family | Proposed minimum acceptance scenario | Suggested routines | Pi status |
|---|---|---|---:|---|
| Account Research Desk | Research and monitoring | Complete “Account brief before a call” with task-specific evidence | 3 | Not tested |
| Ad Spend Watch | Analysis and finance | Complete “Answer a spend question” with task-specific evidence | 3 | Not tested |
| AI Search Visibility | Research and monitoring | Complete “Build the prompt list” with task-specific evidence | 2 | Not tested |
| Alfred | Agent coordination | Complete “Audit, Repair & Govern” with task-specific evidence | 3 | Not tested |
| Apple Search Ads Review | Analysis and finance | Complete “Bids and budgets” with task-specific evidence | 2 | Not tested |
| Call Follow-Ups | Connected operations | Complete “crm-update-proposal” with task-specific evidence | 1 | Not tested |
| Chief Health Officer | Writing and personal memory | Complete one agreed Chief Health Officer task from its source brief with verified output | 2 | Not tested |
| Clip Bot | Media | Complete “Clip captions and post copy” with task-specific evidence | 2 | Not tested |
| Company Docs Q&A | Connected operations | Complete one agreed Company Docs Q&A task from its source brief with verified output | 0 | Not tested |
| Competitor Watch | Research and monitoring | Complete “Build the watch list” with task-specific evidence | 2 | Not tested |
| Cooper | Research and monitoring | Complete one agreed Cooper task from its source brief with verified output | 3 | Not tested |
| Copy Humanizer | Writing and personal memory | Complete “Anti-slop pass” with task-specific evidence | 1 | Not tested |
| Credit Card Max | Analysis and finance | Complete one agreed Credit Card Max task from its source brief with verified output | 1 | Not tested |
| Critiquito: Design Critique | Design and artifacts | Complete “Accessibility pass” with task-specific evidence | 1 | Not tested |
| Customer Call Coach & Assistant | Connected operations | Complete one agreed Customer Call Coach & Assistant task from its source brief with verified output | 1 | Not tested |
| Customer Proof Desk | Connected operations | Complete “Add sources to the proof bank” with task-specific evidence | 2 | Not tested |
| Deal Hunting | Research and monitoring | Complete one agreed Deal Hunting task from its source brief with verified output | 2 | Not tested |
| Deal Inspector | Connected operations | Complete “crm-writeback” with task-specific evidence | 1 | Not tested |
| dial bot | Specialist external execution | Make an explicitly approved call to a dedicated test number; verify call status and scoped transcript | 0 | Not tested |
| dr eggbot | Agent coordination | Complete “Design a Grok Bot” with task-specific evidence | 2 | Not tested |
| EBR & Value Deck Builder | Design and artifacts | Complete “brand-kit” with task-specific evidence | 1 | Not tested |
| Event Producer | Connected operations | Complete “Build the event brief” with task-specific evidence | 3 | Not tested |
| Event Request Desk | Connected operations | Complete “Draft the reply” with task-specific evidence | 3 | Not tested |
| Executive Assistant | Connected operations | Complete one agreed Executive Assistant task from its source brief with verified output | 4 | Not tested |
| figma bro | Design and artifacts | Complete “Build a screen from a brief” with task-specific evidence | 2 | Not tested |
| Flora: Plant Care Log | Writing and personal memory | Complete “Houseplant care card” with task-specific evidence | 0 | Not tested |
| Game Art Director | Design and artifacts | Complete “Asset consistency check” with task-specific evidence | 2 | Not tested |
| GTM Account Research | Research and monitoring | Complete “account-research” with task-specific evidence | 1 | Not tested |
| GTM Connections | Connected operations | Complete “agent-orchestration” with task-specific evidence | 1 | Not tested |
| GTM Loop Closer | Connected operations | Complete “agent-orchestration” with task-specific evidence | 1 | Not tested |
| GTM Prospecting | Connected operations | Complete “agent-orchestration” with task-specific evidence | 1 | Not tested |
| Haggle Bot | Analysis and finance | Complete “build-spend-inventory” with task-specific evidence | 2 | Not tested |
| Hiring Signals | Research and monitoring | Complete “agent-orchestration” with task-specific evidence | 1 | Not tested |
| Home robots | Specialist external execution | Connect a supported test device; execute one explicitly approved safe action and verify actual device state | 0 | Not tested |
| Imogen | Design and artifacts | Clarify the source role and required output through conversation before qualifying an original workflow | 0 | Not tested |
| last30days | Research and monitoring | Complete “last30days” with task-specific evidence | 0 | Not tested |
| Lead Pipeline Desk | Connected operations | Complete “Build the lead ledger” with task-specific evidence | 2 | Not tested |
| Lingxi's Engineer Bot | Engineering | Complete “Engineering playbook” with task-specific evidence | 0 | Not tested |
| Love ❤️ | Writing and personal memory | Complete one agreed Love ❤️ task from its source brief with verified output | 3 | Not tested |
| Luma Pages | Design and artifacts | Complete one agreed Luma Pages task from its source brief with verified output | 0 | Not tested |
| Meeting Recap Deck | Design and artifacts | Complete “Build the recap deck” with task-specific evidence | 2 | Not tested |
| Nightly Audit Engineer | Engineering | Complete one agreed Nightly Audit Engineer task from its source brief with verified output | 1 | Not tested |
| NYC Parent | Research and monitoring | Complete one agreed NYC Parent task from its source brief with verified output | 0 | Not tested |
| Office Ops Desk | Connected operations | Complete “Build the office ops ledger” with task-specific evidence | 3 | Not tested |
| Outbound Prospecting | Connected operations | Complete “Build the target list” with task-specific evidence | 3 | Not tested |
| Overheard | Connected operations | Complete “overheard” with task-specific evidence | 1 | Not tested |
| Paid Media Report Desk | Analysis and finance | Complete “Answer a reporting ask” with task-specific evidence | 3 | Not tested |
| Partnerships Call Coach | Connected operations | Complete one agreed Partnerships Call Coach task from its source brief with verified output | 1 | Not tested |
| Pipeline Pulse | Connected operations | Complete “agent-orchestration” with task-specific evidence | 1 | Not tested |
| Pitch Deck Coach | Design and artifacts | Complete “pdc-methodology” with task-specific evidence | 0 | Not tested |
| Product Idea Stress Test | Writing and personal memory | Complete “pist-evidence-investigator” with task-specific evidence | 0 | Not tested |
| Product Support Inbox Assistant | Connected operations | Complete one agreed Product Support Inbox Assistant task from its source brief with verified output | 0 | Not tested |
| Projects Manager | Connected operations | Complete “Grok Bot project ops” with task-specific evidence | 0 | Not tested |
| Recruiting Coordinator | Connected operations | Complete “Build the hiring tracker” with task-specific evidence | 7 | Not tested |
| Researchy | Research and monitoring | Complete “Grok CLI research pass” with task-specific evidence | 0 | Not tested |
| Sales Call Coach | Connected operations | Complete “Call scorecard” with task-specific evidence | 2 | Not tested |
| SEO & AEO Desk | Research and monitoring | Complete “Answer engine question map” with task-specific evidence | 3 | Not tested |
| Signal Prospector | Research and monitoring | Complete “account-tiering” with task-specific evidence | 1 | Not tested |
| Site Audit | Research and monitoring | Complete one agreed Site Audit task from its source brief with verified output | 2 | Not tested |
| skippy | Research and monitoring | Complete “SF street cleaning lookup” with task-specific evidence | 0 | Not tested |
| Stills & Clips Desk | Media | Complete “Export sizes, captions, and alt text” with task-specific evidence | 1 | Not tested |
| Talent Discovery | Connected operations | Complete “Dedupe against your pipeline” with task-specific evidence | 2 | Not tested |
| Tech Demos | Research and monitoring | Complete “Project planning” with task-specific evidence | 1 | Not tested |
| The Morning Newspaper | Research and monitoring | Complete “Morning newspaper bootstrap” with task-specific evidence | 0 | Not tested |
| tinkabot | Engineering | Complete “prove-plugin-local” with task-specific evidence | 0 | Not tested |
| Tradbot | Connected operations | Complete “Family calendar briefs” with task-specific evidence | 5 | Not tested |
| Video Edit Desk | Media | Complete “Captions and transcript” with task-specific evidence | 1 | Not tested |
| Webby | Engineering | Complete “Strip AI-isms” with task-specific evidence | 6 | Not tested |
| Writing Bot | Writing and personal memory | Complete “Writing revision” with task-specific evidence | 0 | Not tested |
| WTD | Connected operations | Complete “Comms source of truth” with task-specific evidence | 1 | Not tested |
| X Brief | Research and monitoring | Complete “Build the X watch list” with task-specific evidence | 2 | Not tested |

## Matrix-Specific and Website Starting Points

| Entry | Minimum acceptance | Pi status |
|---|---|---|
| Jev Inbox Triage | Use the owner-bound Gmail preview capability; preserve its existing restricted authority and admission gates; no send or label mutation | Not tested |
| Personal Daily Brief skill | Gmail plus Calendar, conversational timezone/account selection, linked sources, explicit gaps; no implicit scheduling | Not tested |
| Website: market-research | Produce a dated sourced comparison brief from authorized inputs | Not tested |
| Website: weekly-report | Produce a source-linked report without inventing metrics or scheduling itself | Not tested |
| Website: bug-fix | Reproduce, test, patch, and report executed checks in an isolated workspace | Not tested |
| Website: campaign-brief | Draft evidence-backed angles and copy; publication requires authority | Not tested |
| Website: meeting-follow-up | Extract commitments with source evidence; task/calendar/message writes require authority | Not tested |
| Website: spend-review | Calculate a verified inventory and separate potential from realized savings; no implicit cancellation | Not tested |

The six website entries are separate task-brief contracts in `matrix-recipes.generated.ts`, not additional installed bot configurations. Preserve their IDs and meaning. Personal Daily Brief is a bundled skill, not an extra marketplace row.

## Full-Parity Release Gate

For every row, record the recipe version, installed skill versions, exact integration actions/accounts, model capability requirements, computer/application dependencies, human approval points, supported surfaces, test fixtures, observed results, and remaining blockers. Each source skill and routine must be mapped, including those beyond the current first-five handoff truncation and eight-dependency contract limits. The minimum scenario above is an entry test, not acceptance of every listed capability.

Full catalogue acceptance requires exercising all mapped capabilities for each recipe and explicitly reporting supported external prerequisites. Telephony, robotics, payment rails, proprietary apps, and blocked websites require individual qualification. No browser or Pi capability claim substitutes for an unavailable external service. A release may advertise only the validated subset, with unavailable recipes clearly marked.
