# First-party launch lineup

Target eight hero apps, with at least five passing the full store and mobile launch gates. The designs below are proposed work; existing connected-starter configurations are not eight finished bespoke apps. Owner Folio and Atlas provide the visual benchmark without supplying anyone's private records.

| App | Primary experience and signature interaction | Initial sources | Phone adaptation |
| --- | --- | --- | --- |
| Folio | Calm spending overview; tap a weekly/monthly chart to inspect receipts; category breakdown and uncertainty review queue | Exact Gmail accounts; manual receipts | Readable chart and currency selector, receipt list, touch detail sheet, accessible category editing |
| Atlas | Photo-led journey collection; interactive destination map; evidence-backed itinerary with flights, stays and plans | Gmail and Google Calendar; manual plans | Switch map/list, tap destination pins, swipe itinerary dates, expandable travel evidence; gestures preserve page navigation |
| Agenda | A readable day timeline, all-day strip and next-up card; move between days and weeks | Google Calendar; manual notes | Thumb-reachable date controls, chronological cards and full event details; timezone and daylight-saving correctness |
| Subscriptions | Recurring-cost collection and renewal timeline; confirm inferred recurrence from actual evidence | Gmail; manual entries | Vendor cards, renewal detail sheet and currency/cadence controls; uncertainty remains visible |
| Focus | One purposeful timer, task commitment and completed-session journal | No connection required | Large timer/start/pause controls; elapsed time reconciles after backgrounding; recover unsaved completion and save history |
| Meeting Briefs | Meeting countdown, attendees, source-supported preparation brief and owner action notes | Calendar and Gmail; optional Drive later | Meeting list and compact briefing sections; evidence and notes stay reachable while typing |
| Projects | Milestones, issue lanes and a dated work timeline; inspect a project without invented health percentages | Linear; optional GitHub later | Project summary then labeled issue lanes/list, owner filters and issue details; preserve comparison through deliberate scrolling |
| Revenue | Currency-safe settled-revenue overview, invoice/payment reconciliation and outstanding invoice lanes | Stripe; manual bookkeeping notes | Simple period/currency controls, readable charts, invoice list and reconciliation sheet |

Projects and Revenue must demonstrate their exact supported account/action/import path before being promoted. Stripe invoices and payment intents must reconcile without double-counting. Repeated email receipts do not prove a subscription, next renewal or successful payment. Calendar plans do not prove a flight booking. Focus may not depend on a foreground-only interval for timing.

Every hero receives its own DESIGN.md, navigation and hierarchy, one convincing main interaction, complete empty/loading/error/saving/conflict states, and screenshots captured from that implemented release in desktop and phone layouts. Shared components handle common data/evidence mechanics; they must not flatten every product into the same dashboard.

## Wider idea library

The reusable library retains 12 Personal and 12 Business concepts. This is an idea and release roadmap, not a claim that every concept is ready for launch.

| Personal app | Useful job | Candidate supported sources |
| --- | --- | --- |
| Folio | Understand email-documented spending | Gmail |
| Atlas | Organize trips and confirmations | Gmail, Calendar |
| Agenda | See the day clearly | Calendar |
| Follow-ups | Track messages needing a response without sending automatically | Gmail |
| Subscriptions | Review recurring charges and evidenced renewals | Gmail |
| Deliveries | Collect orders and shipment evidence | Gmail |
| Reading Library | Save and organize material worth reading | Gmail, Drive |
| People | Keep useful owner notes and contact context | Gmail, Calendar |
| Files | Find and group documents with source references | Drive |
| Notes | Collect notes with a deliberate reading/editor surface | Notion, Drive |
| Habits | Build a consistent routine with saved history | Manual first |
| Focus | Commit to a task and record focused sessions | Manual first |

| Business app | Useful job | Candidate supported sources |
| --- | --- | --- |
| Cashflow | Compare evidenced money in/out without forecasting invented balances | Stripe, Gmail |
| Revenue | Reconcile settled payments and invoices | Stripe |
| Pipeline | Review leads and explicitly confirmed deal stages | Gmail; CRM connector later |
| Projects | Understand milestones and issues | Linear |
| Meeting Briefs | Arrive prepared with traceable context | Calendar, Gmail |
| Support | Triage requests and preserve source context | Gmail, Slack |
| Hiring | Organize candidates and interview plans | Gmail, Calendar |
| Company Spend | Separate work costs and review vendor evidence | Gmail |
| Releases | Follow issue-to-release work | GitHub, Linear |
| Knowledge | Browse company references in one readable collection | Notion, Drive |
| Campaigns | Organize campaign plans and source evidence | Notion, Drive |
| Analytics | Understand actual product signals with source-supported charts | PostHog |

These are candidate sources, not a scope grant. Validate the exact current actions/scopes and account status before connecting an app. Future ideas include a Granola meeting notebook, Jira delivery view and Figma design-review collection after approved connector actions and bounded source models exist. Do not present unsupported analytics or CRM actions as available.

## Useful design directions

Folio and Revenue should feel precise and calm; Atlas can be photographic and exploratory; Agenda should prioritize time and reading; Subscriptions should make recurrence uncertainty clear; Focus should remove clutter; Meeting Briefs should resemble a useful preparation document; Projects should support quick comparison. Keep Matrix chrome consistent while allowing app-local typography, imagery and visual identity.

Use reusable accessible components where they improve quality. Capture real product screenshots rather than drawing look-alike interfaces. Phone screenshots show the actual phone composition, not a scaled-down desktop screen. Examples are fictional, visibly labeled and isolated from owner storage.
