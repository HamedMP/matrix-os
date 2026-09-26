# Recipe Capability and Acceptance Map

Baseline: all 71 metadata entries in `packages/ui/src/chat-agents/agent-inspirations.generated.ts`, plus Jev from `AgentRecipesPanel.tsx`, at Matrix `5f9fc5362` (2026-09-26). This is a proposed qualification map, not a statement that these capabilities work today.

Every row starts **not tested** for the proposed Pi runtime. Human-readable skill names are metadata, not installed executable skills. Build original Matrix procedures; preserve provenance without copying private prompts. Each row names a proposed task and the observable result that would show it worked; a follow-up must turn each into concrete input fixtures, exact connector actions or application access, and recorded evidence.

Routines listed in the source remain suggestions until the user activates them in conversation. Some source entries have no skills or integrations; missing metadata is not proof that the workflow needs no tools. The spike program covers representative families only.

Source skill names that reference another vendor's product, such as "Design a Grok Bot", "Grok Bot project ops", and "Grok CLI research pass", are provenance only. Matrix procedures, scenarios, and user-facing copy use neutral names.

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

## Proposed Launch Set (M1)

FR-013 requires a validated launch set before launch. The proposal below needs owner confirmation. It covers six capability families using connectors, web research, and artifacts only, so no entry depends on computer use (M4), groups (M3), or scheduling (M2).

| Entry | Family | Why it is in the launch set |
|---|---|---|
| Jev Inbox Triage | Connected operations | Already ships an owner-bound, read-only Gmail capability; proves migration without widening authority |
| Personal Daily Brief skill | Connected operations | Story 1 independent test; exercises Gmail plus Calendar progressive connection and account choice |
| Competitor Watch | Research and monitoring | Spike's Research Rabbit; dated evidence from public pages |
| Account Research Desk | Research and monitoring | Research brief from public web and pasted notes; optional connectors requested progressively |
| Event Request Desk | Connected operations | Exact-draft approval path for an outbound reply |
| Writing Bot | Writing and personal memory | Preference memory and correction with no integrations |
| Meeting Recap Deck | Design and artifacts | Verifiable file artifact (deck) from provided notes |
| Website: spend-review | Analysis and finance | Calculations checked against a fixture; potential versus realized savings |

## Complete Marketplace Inventory

| Recipe | Family | Proposed task -> observable result | Suggested routines | Pi status |
|---|---|---|---:|---|
| Account Research Desk | Research and monitoring | From a synthetic account name and pasted notes, write a pre-call brief -> brief file with a dated source link for every claim and a separate open-questions list | 3 | Not tested |
| Ad Spend Watch | Analysis and finance | From a seeded ad-platform CSV, answer which campaign is over budget pace this week -> named campaign with a pace figure matching the fixture; no campaign change without approval | 3 | Not tested |
| AI Search Visibility | Research and monitoring | Build a 10-question buyer prompt list for a synthetic product and record one pasted assistant answer -> file with prompts, the captured answer, and the brands it names | 2 | Not tested |
| Alfred | Agent coordination | Audit the owner's existing bots -> report of each bot's job, overlapping jobs, and proposed changes; nothing created or edited without exact approval | 3 | Not tested |
| Apple Search Ads Review | Analysis and finance | From a seeded Search Ads export and a cost-per-install target, draft bid and budget changes -> change sheet whose per-keyword cost per install matches the fixture; account untouched | 2 | Not tested |
| Call Follow-Ups | Connected operations | From a seeded call transcript, draft the recap email and CRM field updates -> Gmail draft in the test account plus a proposed CRM update awaiting approval; nothing sent or saved | 1 | Not tested |
| Chief Health Officer | Writing and personal memory | Given a missed training day stated in conversation and no connected health source, rewrite the rest of the week -> revised plan that states no data source is connected and invents no metrics | 2 | Not tested |
| Clip Bot | Media | From a seeded 10-minute recording, produce two captioned clips -> two exported clips that play, with timestamps and captions matching the source transcript | 2 | Not tested |
| Company Docs Q&A | Connected operations | Answer three seeded product questions from a test Notion workspace -> each answer cites the exact page; an unanswerable fourth question is reported as not found, not invented | 0 | Not tested |
| Competitor Watch | Research and monitoring | Build a watch list from three pasted URLs and diff one against a changed fixture page -> watch list plus a change summary quoting the changed text with capture dates | 2 | Not tested |
| Cooper | Research and monitoring | Produce a briefing of five top stories on a named topic -> each story has a source link and publication date; Slack delivery only to an owner-approved destination | 3 | Not tested |
| Copy Humanizer | Writing and personal memory | Edit a seeded AI-sounding draft -> revised draft plus a change list with reasons; no claim absent from the source is introduced | 1 | Not tested |
| Credit Card Max | Analysis and finance | Store owner-described cards and perks as preferences, then recommend a card for a stated purchase -> recommendation naming the rule applied; a second question reuses the stored cards without asking again | 1 | Not tested |
| Critiquito: Design Critique | Design and artifacts | Critique a seeded screenshot -> ranked fix list including the seeded contrast failure with the measured color pair; source file untouched | 1 | Not tested |
| Customer Call Coach & Assistant | Connected operations | From a seeded call transcript, produce post-call coaching -> coaching note that quotes a transcript line as evidence for each point | 1 | Not tested |
| Customer Proof Desk | Connected operations | Add two pasted call notes to a proof bank and pull a quote supporting a stated claim -> proof-bank file whose returned quote matches the source word for word | 2 | Not tested |
| Deal Hunting | Research and monitoring | Find landed cost (price, shipping, tax) for a named product at two retailers -> comparison with source links and capture time; no purchase attempted | 2 | Not tested |
| Deal Inspector | Connected operations | Check a seeded stage change against a qualification rubric using its transcript -> verdict with quoted evidence and missing criteria, plus a CRM writeback proposal awaiting approval | 1 | Not tested |
| dial bot | Specialist external execution | Make an explicitly approved call to a dedicated test number; verify call status and scoped transcript | 0 | Not tested |
| dr eggbot | Agent coordination | Design a new Matrix bot from a stated job through conversation -> proposed definition (job, voice, anti-jobs, tools) shown for approval; after approval exactly one bot and one direct chat exist | 2 | Not tested |
| EBR & Value Deck Builder | Design and artifacts | From seeded CRM and usage fixtures, build a value deck for a named account -> editable deck that opens, with every number traceable to a fixture row | 1 | Not tested |
| Event Producer | Connected operations | From pasted event details, build the event brief and run of show -> brief with schedule, vendors, and guest dietary needs matching the input | 3 | Not tested |
| Event Request Desk | Connected operations | Score a pasted sponsorship request against a rubric and draft the reply -> score with rubric reasons and a Gmail draft in the test account; not sent | 3 | Not tested |
| Executive Assistant | Connected operations | Check a seeded sheet of executive meetings against the test Calendar -> list of missing and time-shifted meetings matching the fixture; no calendar edits without approval | 4 | Not tested |
| figma bro | Design and artifacts | Turn a seeded Figma frame, or a pasted link when Figma is not connected, into a build spec -> spec listing components, tokens, and spacing that match the frame | 2 | Not tested |
| Flora: Plant Care Log | Writing and personal memory | Create care cards for two named plants, then state a watering preference -> journal with two cards; the preference updates only the named plant's card | 0 | Not tested |
| Game Art Director | Design and artifacts | Check three seeded sprites against a palette and grid -> report flagging the one sprite with off-palette colors and grid drift | 2 | Not tested |
| GTM Account Research | Research and monitoring | Research one synthetic account before a meeting -> brief with company changes, people, relationship history from the test CRM, and a source for each finding | 1 | Not tested |
| GTM Connections | Connected operations | Find warm paths into a target account from seeded contacts and email history -> ranked paths with evidence for each and an introduction-request draft; not sent | 1 | Not tested |
| GTM Loop Closer | Connected operations | Find open commitments in seeded meeting notes and email -> list of commitments with source quotes and drafted follow-ups; not sent | 1 | Not tested |
| GTM Prospecting | Connected operations | Turn a stated ideal-customer profile into a prospect list -> 10 prospects with public sources, duplicates checked against the test CRM, and first-touch drafts; not sent | 1 | Not tested |
| Haggle Bot | Analysis and finance | From a seeded SaaS spend export, build the spend inventory -> sheet whose totals match the fixture, with unused-seat savings labeled potential, not realized | 2 | Not tested |
| Hiring Signals | Research and monitoring | Detect new postings at two tracked companies from fixture careers pages -> digest of changes with posting links and dates, matched to the owning account | 1 | Not tested |
| Home robots | Specialist external execution | Connect a supported test device; execute one explicitly approved safe action and verify actual device state | 0 | Not tested |
| Imogen | Design and artifacts | Write alt text for three seeded images -> alt text under 150 characters each that names the primary subject, reviewed against a human-written reference | 0 | Not tested |
| last30days | Research and monitoring | Write a brief on a named topic from the last 30 days -> every cited post is dated within the window and linked; installing a third-party skill requires explicit approval | 0 | Not tested |
| Lead Pipeline Desk | Connected operations | From a seeded lead CSV, build the lead ledger -> ledger with duplicates merged (count matches fixture), scores, and owners; no outreach | 2 | Not tested |
| Lingxi's Engineer Bot | Engineering | Break a stated feature into tasks and open one PR in a test repository from an isolated workspace -> PR exists with passing test evidence; merge left to the owner | 0 | Not tested |
| Love ❤️ | Writing and personal memory | Using stored partner preferences, propose three date options for a named weekend -> options with links and times that avoid a seeded Calendar conflict; nothing booked | 3 | Not tested |
| Luma Pages | Design and artifacts | Draft event page copy and settings from a seeded Notion brief -> draft whose capacity, waitlist, and registration settings match the brief; not published | 0 | Not tested |
| Meeting Recap Deck | Design and artifacts | From pasted meeting notes and a seeded slide template, build the recap deck -> deck that opens, uses the template, and quotes only text present in the notes | 2 | Not tested |
| Nightly Audit Engineer | Engineering | Audit one area of a test repository -> one cleanup PR with passing tests and a findings summary; a schedule is proposed, not activated | 1 | Not tested |
| NYC Parent | Research and monitoring | Turn a seeded school email into next actions -> dated action list, a calendar event proposal, and no spending or replies without approval | 0 | Not tested |
| Office Ops Desk | Connected operations | From a pasted shipment list, build the office ops ledger -> ledger flagging late shipments against the current date and a digest draft; not sent | 3 | Not tested |
| Outbound Prospecting | Connected operations | Build a target list for a stated profile -> list with public-web research per name and first-message drafts; nothing sent | 3 | Not tested |
| Overheard | Connected operations | Find mentions of a synthetic brand in fixture pages -> digest listing each mention with its link; a fixture day with no mentions produces no digest | 1 | Not tested |
| Paid Media Report Desk | Analysis and finance | Answer a reporting question from seeded Google Ads and Meta exports -> numbers matching the fixtures with the calculation shown; posting only after approval | 3 | Not tested |
| Partnerships Call Coach | Connected operations | Review a seeded pitch-call transcript -> what landed, what to tighten, and rewritten phrasings, each tied to a quoted line | 1 | Not tested |
| Pipeline Pulse | Connected operations | Scan a seeded pipeline for stale next steps -> stale deals matching the fixture, with drafted CRM updates awaiting approval | 1 | Not tested |
| Pitch Deck Coach | Design and artifacts | Review a seeded pitch deck -> slide-by-slide list of likely investor questions and the top three fixes | 0 | Not tested |
| Product Idea Stress Test | Writing and personal memory | Stress-test a stated product idea -> must-be-true assumptions, sourced evidence for and against, the riskiest assumption, and one proposed test | 0 | Not tested |
| Product Support Inbox Assistant | Connected operations | Draft answers to two seeded support emails -> Gmail drafts in the test account citing the product document used; not sent | 0 | Not tested |
| Projects Manager | Connected operations | Create a project row and task list in a test Notion database from a stated project -> row and tasks exist; assigning work to another bot requires an explicit handoff | 0 | Not tested |
| Recruiting Coordinator | Connected operations | From seeded candidate and interviewer availability, propose an interview loop -> schedule that fits every seeded calendar plus a candidate message draft; not sent | 7 | Not tested |
| Researchy | Research and monitoring | Fact-check three stated claims -> verdict per claim with dated sources; unverifiable claims labeled unverifiable | 0 | Not tested |
| Sales Call Coach | Connected operations | Score a seeded sales-call transcript -> scorecard with talk ratio and filler counts computed from the transcript, plus fixes for the next call | 2 | Not tested |
| SEO & AEO Desk | Research and monitoring | Map a pasted keyword list to answer-engine questions -> question map and one writer brief with sources | 3 | Not tested |
| Signal Prospector | Research and monitoring | Tier accounts from seeded CRM and product-usage fixtures -> ranked accounts with the signal behind each rank; first-touch drafts not sent | 1 | Not tested |
| Site Audit | Research and monitoring | Audit a controlled test site -> P0/P1/P2 findings with evidence URLs, including the seeded broken link and missing alt text | 2 | Not tested |
| skippy | Research and monitoring | Look up the next posted street sweep for a given San Francisco address from public city data -> date and time with the data source cited; no claim that parking is legal | 0 | Not tested |
| Stills & Clips Desk | Media | Pull two stills from seeded footage for two destinations -> image files at the requested sizes with captions and alt text | 1 | Not tested |
| Talent Discovery | Connected operations | Source five candidates for a stated role and dedupe against a seeded ATS export -> shortlist with public sources that excludes the seeded duplicates | 2 | Not tested |
| Tech Demos | Research and monitoring | Pick one library from fixture bookmarks and plan a demo -> plan with the library link and scope; building starts only after approval | 1 | Not tested |
| The Morning Newspaper | Research and monitoring | Lay out a one-page newspaper from the test Gmail and Calendar -> rendered page containing the seeded events and emails; printing not attempted | 0 | Not tested |
| tinkabot | Engineering | Wrap a stub test API as a local MCP plugin -> plugin passes a local call test; publishing requires explicit approval | 0 | Not tested |
| Tradbot | Connected operations | Build a family calendar brief from the test Gmail and Calendar -> brief flagging the seeded pickup conflict and form deadline, plus a reply draft; not sent | 5 | Not tested |
| Video Edit Desk | Media | Burn captions into a seeded clip -> exported clip that plays with captions matching the transcript; original file unchanged | 1 | Not tested |
| Webby | Engineering | Remove AI-isms from a seeded post in a test site repository -> PR with the edited post and the list of removed phrases; no deletions | 6 | Not tested |
| Writing Bot | Writing and personal memory | Revise a seeded essay after one stated style preference -> revised text with structural notes; claims and meaning preserved, and the preference is applied to a second draft without restating it | 0 | Not tested |
| WTD | Connected operations | Build a status summary from seeded Notion plan pages -> outstanding asks with owners; private notes excluded from the shared output | 1 | Not tested |
| X Brief | Research and monitoring | Build a watch list from three handles and a daily brief from fixture posts -> brief with post links; nothing posted | 2 | Not tested |

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

For every row, record the recipe version, installed skill versions, exact integration actions/accounts, model capability requirements, computer/application dependencies, human approval points, supported surfaces, test fixtures, observed results, and remaining blockers. Each source skill and routine must be mapped, including those beyond the current first-five handoff truncation and eight-dependency contract limits. The proposed task above is an entry test, not acceptance of every listed capability.

Full catalogue acceptance requires exercising all mapped capabilities for each recipe and explicitly reporting supported external prerequisites. Telephony, robotics, payment rails, proprietary apps, and blocked websites require individual qualification. No browser or Pi capability claim substitutes for an unavailable external service. A release may advertise only the validated subset, with unavailable recipes clearly marked.
