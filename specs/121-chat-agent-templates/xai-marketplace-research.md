# xAI Bot marketplace research snapshot

Captured from the [public xAI Bot marketplace](https://x.ai/bot/marketplace) on 2026-09-11, with design research from SpaceXAI's [“Designing Grok Bot for a world of persistent agents”](https://x.ai/news/designing-grok-bot), published 2026-09-03. The official article has no individual author byline; attribution here is to its publisher, SpaceXAI. The article URL, title, date, and absence of an individual byline were rechecked on 2026-09-16. This is product research, not a claim that Matrix may redistribute the listed creators' full text or assets.

The complete machine-readable catalogue is persisted in
[`xai-marketplace-inventory.json`](./xai-marketplace-inventory.json). It keeps
all 71 bot identities, creators, categories, descriptions, capability names,
counts, integration names, source links, appearance metadata, and content
fingerprints. Full third-party prompt-like memory and capability text is not
republished.

### Historical fingerprint limitation

The original hash-producing capture script and raw inputs were not recovered
during the 2026-09-16 review. The four fingerprint fields are historical capture
metadata only: `promptSurface.memoryContentSha256`, `skills.contentSha256`,
`routines.summarySha256`, and `integrations.descriptionSha256`.
Their exact input fields, ordering, serialization, separators, whitespace,
Unicode normalization, and empty or missing value handling are unknown.
We retain the recorded values without inventing a canonicalization procedure.
They cannot prove equivalence or change against a future scrape. Tests validate
the persisted metadata's internal consistency and hash-shaped strings, not the
omitted source material or the correctness of those historical hashes.

A future capture must version and retain its extraction/hash procedure and
permitted input evidence before making reproducible comparison claims. The
current snapshot can be compared only on its explicitly retained public fields.

## Inventory

The public marketplace exposed 71 Bots from 43 creators. The observed catalogue was:

Account Research Desk; GTM Account Research; AI Search Visibility; Alfred; Apple Search Ads Review; Video Edit Desk; Call Follow-Ups; Chief Health Officer; Clip Bot; Company Docs Q&A; Competitor Watch; Cooper; Credit Card Max; Critiquito: Design Critique; Customer Call Coach & Assistant; Product Support Inbox Assistant; Customer Proof Desk; Partnerships Call Coach; Deal Hunting; Deal Inspector; dial bot; dr eggbot; EBR & Value Deck Builder; Meeting Recap Deck; Lingxi's Engineer Bot; Event Producer; Event Request Desk; figma bro; Flora: Plant Care Log; GTM Loop Closer; Executive Assistant; Ad Spend Watch; Haggle Bot; Hiring Signals; Home robots; Copy Humanizer; Stills & Clips Desk; Imogen; last30days; Lead Pipeline Desk; Love ❤️; Luma Pages; Recruiting Coordinator; Nightly Audit Engineer; NYC Parent; Office Ops Desk; Overheard; Outbound Prospecting; Pipeline Pulse; Pitch Deck Coach; Product Idea Stress Test; Projects Manager; GTM Prospecting; Researchy; Game Art Director; Sales Call Coach; SEO & AEO Desk; Talent Discovery; Signal Prospector; Site Audit; skippy; Paid Media Report Desk; Tech Demos; The Morning Newspaper; tinkabot; Tradbot; GTM Connections; Webby; Writing Bot; WTD; and X Brief.

The scrape found 446 public memory entries, 286 skills, 110 routines, and 268 integration references. No separate public `instructions` field was populated; role-like prompt material was exposed through public memory entries. Sixty-seven Bots had memory, 56 skills, 53 routines, and 53 integration references.

Most frequent categories were From Grok Bot Team (46), Sales (21), Marketing (17), Personal (12), Engineering (5), Design (4), Operations (4), Product (3), and Recruiting & People (2). Common integrations included Gmail, Google Calendar, Google Sheets, Slack, Notion, Linear, Figma, Salesforce, Granola, Google Drive, Gong, HubSpot, Databricks SQL, Attio, X, and smaller specialist services.

## Product model to carry into Matrix

- Treat Agents as a roster of durable collaborators, not renamed Chat history.
- Keep account-level capabilities (installed skills and tools) separate from Agent-level configuration (instructions, selected capabilities, memory, and eventually routines).
- Present recipes as installable starting points that create owner-controlled Agent files; marketplace entries must never remain opaque platform state.
- Make capability requirements legible before install and surface missing connections without exposing credentials.
- Preserve source attribution, creator ownership, versioning, review state, declared permissions, and an explicit update path for a future marketplace package format.
- Keep one-off prompts, reusable skills, routines, tools, and generated artifacts distinct even when the transcript presents them together.

## Design language applied in this PR

The official article's [“Presence as interface” section](https://x.ai/news/designing-grok-bot) frames presence around identity, activity, and how much detail a person needs. The following are Matrix design choices informed by that article, not claims about code or assets imported from xAI:

- stable, geometric Agent avatars derived from the Agent ID so collaborators are recognizable at a glance;
- a roster layout with role and capability summaries instead of undifferentiated configuration buttons;
- progressive disclosure: the library shows identity and a compact readiness/capability summary, while full instructions, skills, integrations, and output remain in the editor;
- recipes are visually separated from already-created collaborators;
- “Ready to mention” describes configuration availability only. Working, waiting, blocked, and done states are deferred until canonical Run lifecycle data can drive them without fabricated presence.

Later marketplace work should add signed packages, moderation, permission review, creator pages, install/update semantics, and runtime-backed presence. It should not copy third-party prompts or artwork into Matrix without an appropriate licence.
