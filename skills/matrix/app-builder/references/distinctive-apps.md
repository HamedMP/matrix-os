# Distinctive apps and landing pages

Research checked 2026-10-07 against official Lovable/Replit guides, practicing designers, and bounded authenticated X API searches. These are design practices to adapt, not installed tool capabilities. Follow the user's direction and preserve Matrix runtime, ownership and accessibility contracts.

## What the research changes

[Lovable's prompting guide](https://docs.lovable.dev/prompting/prompting-one) recommends defining the audience and main action early, giving concrete content and visual direction, then improving bounded components. Its [design guidance](https://docs.lovable.dev/features/design-guidance) supports exploring alternatives. Save selected decisions in project knowledge instead of repeatedly starting from a vague aesthetic adjective.

[Replit's prompting guide](https://docs.replit.com/learn/effective-prompting) emphasizes precise requirements, relevant files/mockups and incremental verification. Its [current Design product](https://replit.com/blog/introducing-replit-design) combines visual references, templates and design systems. Older standalone Design Mode tutorials are historical; do not present their workflow as current. Matrix has its own runtime: use these design practices without adopting Replit hosting or Lovable Cloud as Matrix persistence.

[Emil Kowalski](https://emilkowal.ski/ui/agents-with-taste) explains why an explicit rule plus its reason transfers design judgment better than praise words. [Linear's refresh](https://linear.app/now/behind-the-latest-design-refresh) reduces competing navigation weight and unnecessary separators. [Rauno's interaction essay](https://rauno.me/craft/interaction-design) studies responsiveness, input and continuity; its examples support testing how a flow feels in use, beyond a static image. [Impeccable](https://github.com/pbakaus/impeccable) separates product context, visual direction, critique and technical audits. These are useful practices; no additional external skill is installed by reading this reference.

X searches found [Emil's October 4 post](https://x.com/emilkowalski/status/2106752670405099523) about touch-specific polish and stress-testing content, corroborated by his [repository](https://github.com/emilkowalski/skills). [Karri's October 3 post](https://x.com/karrisaarinen/status/2106260123387859089) distinguishes working software from a flow that makes sense for the user's intention. Treat social posts as discovery leads, not proof that a tool or pattern works in Matrix. Search results, popularity counts and marketing screenshots do not validate actual behavior.

## Give each product a recognizable silhouette

Start with the app's central object and action. A trip has geography; a schedule has time; a document needs reading space; a timer needs focus. Choose navigation and density to support those objects. Sharing a bridge or accessible controls does not require sharing a sidebar, page header, stat row and card grid.

Before building several apps, write a collection matrix in DESIGN.md covering each app's first screen, navigation, typography, dominant content, imagery and signature interaction. Compare their silhouettes at phone size and gallery-thumbnail size. If the names, accents and glyphs were removed, could someone still distinguish their tasks? If several have the same composition, revise the structure before decorating it. A monochrome comparison is a useful critique technique, not an automated proof of design quality.

Proposed Matrix collection directions below are original recommendations, not claims that these redesigns have shipped:

| App | First screen and visual character | Useful signature interaction |
| --- | --- | --- |
| Folio | Spending statement: aligned figures, a readable month trend, categorized receipt rows, crisp light surfaces and a distinct accent | Tap a chart period/category to reveal the corresponding receipts and source evidence |
| Atlas | Geographic overview with destination photography, route lines and an itinerary drawer; map/list choice stays obvious on a phone | Select a map destination or trip photo and keep the selected itinerary synchronized |
| Agenda | Day/week time canvas with a clear current-time marker and compact event details | Open/edit an event in context; preserve date and scroll position on Back |
| Subscriptions | Upcoming renewals arranged by date, recognizable merchant assets and compact cost comparison | Inspect the next charge and its supporting receipt without hunting through an unrelated ledger |
| Focus | One large timer and one task, restrained controls and ample open space | Start/pause/resume immediately; derive elapsed time from timestamps when returning from the background |
| Meeting Briefs | Readable document with attendees, decisions and linked source notes; editorial hierarchy | Expand supporting context beside the relevant question or decision |
| Projects | Dense work board or timeline, compact issue rows and purposeful status grouping | Move work with direct manipulation plus a keyboard/menu equivalent |
| Revenue | Precise revenue trend and payment activity, business density and clearly separated currencies | Select a period or payment to inspect its breakdown and status |

Task references: [Copilot Money](https://www.copilot.money/) and its [dashboard explanation](https://help.copilot.money/en/articles/6045480-dashboard-tab-overview) illustrate spending interpretation; [Wanderlog](https://wanderlog.com/) describes itinerary/map coordination. Adapt their task logic, not their branding or assets. Do not imply that receipt-only Folio knows bank balances or remaining budget without those data sources. Do not sum unlike currencies or fabricate flight status.

## Prompt architecture

Write a compact brief, then build and refine one meaningful screen or flow at a time:

1. **User and situation:** who is opening this, on what device, and what they need right now.
2. **Outcome:** one primary action and the observable completion state.
3. **Composition:** what occupies the most space, how secondary information appears, navigation and density.
4. **Art direction:** specific type roles, palette roles, shapes, image treatment and one memorable useful detail. Explain which reference qualities to adapt.
5. **Content and behavior:** realistic labels, bounded records, loading/empty/error/saving states and data source. Keep fictional examples isolated and visibly labeled.
6. **Mobile and boundaries:** phone arrangement, touch/keyboard/Back, actual Expo launch, caching policy, and the existing behavior to preserve.
7. **Evidence:** rendered comparisons, primary flow tests, persistence, failure recovery and the next focused refinement.

For Lovable, put stable product/design decisions in its project knowledge and use the preview selector for local changes. For Replit, attach the relevant reference/mockup and name the affected screen/files; use its current design workflow for visual iteration and save working milestones. For Matrix, record the same durable decisions in DESIGN.md, use the installed skills and authenticated Matrix bridge, and continue within the user's authorized scope without a mandatory approval after every component.

## A concrete app prompt

```text
Build Atlas for someone checking their upcoming travel on a phone.
The opening screen should answer where I am going next and when.
Make geography and destination photography the main content: a map with
selectable destinations and a compact itinerary panel. At phone width,
use an explicit Map / Trips switch and a detail sheet with visible Back.
Use airy blue-gray map surfaces, dark readable type and crisp controls;
let the photographs carry the color. Keep flight dates and numbers legible.
Selecting a trip highlights its destination; selecting the destination
opens the same trip. Provide a list equivalent for keyboard/screen readers.
Keep work/personal and account filters visible, preserve selection on Back,
and show the source email/calendar evidence. Use only confirmed records.
Implement the existing Matrix/Postgres contract. Verify actual Expo launch,
authenticated reads/edits, keyboard, reopening and safe cache invalidation.
First complete this useful flow, inspect phone and wide-window renders,
then refine the largest mismatch against the selected visual references.
```

This is an original prompt tailored to Matrix, not a copied vendor example. Adapt specifics to the user's actual brief instead of imposing this style on every app.

## Landing pages

A landing page introduces an outcome and gives a visitor a reason to act. An installed app helps a returning user perform the task. They need different first screens even when they share a visual identity.

Prompt for the audience, truthful value proposition, primary CTA, actual product image/demo and the questions a visitor must resolve. Choose a narrative order from those questions; do not automatically add pricing, a three-card feature row, a logo wall or invented testimonials. Keep the app previews large enough to understand, with a real phone composition on phones. Product imagery should do useful explanatory work. A service company may need photography; a developer product may need an interactive example; an App Store needs distinct app previews.

```text
Build the Matrix App Store landing page for people who have never tried it.
Use a premium minimal storefront: crisp typography, generous spacing and
restrained platform color. Lead with “Apps that work with your tools.”
Show a large Atlas map preview alongside a clearly different Folio spending
preview. Use actual rendered app screenshots; label example data honestly.
The primary action is “Explore apps”; the next step lets visitors connect
tools and see recommendations. Explain ownership and the exact installation
flow with concise copy. Do not invent ratings, customers or availability.
On phones show an actual mobile app preview and a reachable CTA.
Build the opening section and gallery first, inspect hierarchy and image
crops, then improve the onboarding transition while preserving its behavior.
```

Refinement prompts should name the problem, location and desired result: “On Atlas's phone trip detail, move the flight number next to the departure time, reduce the unused header space, and keep the active account filter and selected trip.” Avoid “make it more beautiful” as the entire critique.

## Reference evidence and quality check

No screenshot inspection is claimed by this research note: web pages, official documentation and public post text were read; search-returned image descriptions are not rendered visual evidence. The user's gallery screenshot establishes the repeated structure of the current previews. Before implementation, inspect the actual selected reference images with available authorized tools and record source, date, viewport and observed screen. If capture is unavailable, record that limitation and use available user images without claiming unseen behavior.

For each finished app, check recognizable task hierarchy, coherent typography,
readable chart labels, licensed imagery, honest content, keyboard access, touch
targets, reduced motion, long names/dates/currencies, empty/error states and
actual mobile behavior. Fix the most consequential visual mismatch, render
again, and then capture the app's real screen for the gallery. A beautiful
marketing image cannot substitute for a working product or a verified host.
