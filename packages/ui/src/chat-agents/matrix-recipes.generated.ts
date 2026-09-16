// Version 1 is pinned to the exact website source below; its unmodified bytes live
// in tests/contracts/fixtures/matrix-recipes.v1.ts. sourceSha256 hashes those raw
// file bytes, with no parsing, sorting, whitespace, newline or Unicode normalization.
// The recipe-handoff test compares every field and every resolved prompt to that fixture.
// ID-only website links resolve these v1 prompts. Preserve existing IDs and their
// meaning; changed task semantics require a new ID and a coordinated site contract.
// For an intentional catalog update, retain the v1 fixture, add a versioned source
// fixture, and review both repos' IDs/prompts before updating this contract and test.
export const matrixRecipeCatalogContract = {
  version: 1,
  sourceRepository: "FinnaAI/matrix-os-site",
  sourceCommit: "1185ec8efe84ce93a6650369ec7cb3fcfc9e72bd",
  sourcePath: "src/components/landing/recipes.ts",
  sourceSha256: "1562618a2a7e5c7a25063539dcbd15eb7fb44f16a0dae90625e90a1426d72993",
} as const;

// Task briefs for manual use today; these are not installed agent configurations.
export const matrixRecipes = [
  {
    id: "market-research", title: "Research a market", category: "Research & strategy",
    description: "Turn a question and a list of competitors into a brief you can make a decision from.",
    inputs: "Your question, target audience, and competitor URLs or source documents.",
    output: "A sourced brief with comparisons, open questions, and a recommended next step.",
    review: "Check the sources and assumptions before acting on the recommendation.",
    prompt: `Help me research a market. Ask for my question, target audience, and competitor URLs or source documents first.
Use the available sources to compare the products, audience, pricing, and positioning. Date each observation, link its source, and separate facts from inference. If web access or evidence is missing, say so; do not invent current facts.
Save a concise brief in my workspace with a comparison table, open questions, and a recommended next step. Ask for approval before contacting anyone or publishing anything.`,
  },
  {
    id: "weekly-report", title: "Prepare the weekly report", category: "Operations & reporting",
    description: "Turn this week’s updates into a report with progress, blockers, and decisions.",
    inputs: "Your weekly notes or exports, reporting period, and intended audience.",
    output: "A shareable report with source links, unresolved blockers, and suggested next actions.",
    review: "Review the draft before sharing. Scheduling needs a separate setup.",
    prompt: `Prepare my weekly report. Ask for the reporting dates, audience, and notes or exports I want you to use.
Summarize progress, blockers, decisions needed, and proposed next actions. Link each important claim to its source. Mark missing or stale data explicitly and never invent metrics or owners.
Save the report in my workspace for review. Ask for approval before sending or publishing it. Run this once; do not create a schedule unless I ask.`,
  },
  {
    id: "bug-fix", title: "Turn a bug into a reviewed fix", category: "Software engineering",
    description: "Give a coding agent the issue, then inspect the change, tests, and preview together.",
    inputs: "A repository, bug description, reproduction steps, and test instructions.",
    output: "A proposed patch with reproduction evidence, test results, and a review summary.",
    review: "Inspect the diff and tests. Merging and deploying require your approval.",
    prompt: `Help me fix a bug. Ask for the repository, issue, reproduction steps, and test instructions. Follow the repository's contribution rules and use an isolated branch.
Reproduce the issue, write a failing regression test, make the smallest sound fix, and run the relevant checks. If access or reproduction evidence is missing, report the blocker instead of guessing.
Return the patch, test results, and a review summary in this workspace. Do not claim tests passed unless they ran. Ask for approval before merging or deploying.`,
  },
  {
    id: "campaign-brief", title: "Build a campaign brief", category: "Marketing & content",
    description: "Turn customer feedback into a focused campaign and drafts in your brand’s voice.",
    inputs: "Customer notes, product facts, audience, and examples of your brand voice.",
    output: "A campaign brief, three message angles, and draft copy ready to edit.",
    review: "Verify every product claim and approve the copy before publication.",
    prompt: `Build a campaign brief from the customer notes and product facts I provide. Ask for the audience, goal, channel, and examples of our voice.
Identify recurring needs with source references. Propose three message angles and draft copy for the selected channel. If supporting evidence is missing, mark the claim as unverified. Never invent testimonials, metrics, or product capabilities.
Save the brief and drafts in my workspace. Ask for approval before publishing, sending messages, or spending money.`,
  },
  {
    id: "meeting-follow-up", title: "Close the loop after a meeting", category: "Meetings & follow-ups",
    description: "Turn notes into a clear recap and a list of commitments that need a follow-up.",
    inputs: "Meeting notes or a transcript, participant names, and any existing task list.",
    output: "A recap, evidence-linked action list, and follow-up drafts.",
    review: "Confirm owners and dates before creating tasks or sending follow-ups.",
    prompt: `Turn my meeting notes or transcript into a recap. Ask for the source material, participants, and existing task list.
Extract decisions, commitments, and unresolved questions. Reference the source passage for each commitment. Mark missing owners or dates as unknown rather than assigning them yourself. Draft follow-up messages separately.
Save the recap and action list in my workspace. Ask for approval before creating tasks, editing calendars, or sending any message.`,
  },
  {
    id: "spend-review", title: "Review recurring software spend", category: "Finance & operations",
    description: "Find duplicate subscriptions and renewal questions in the records you provide.",
    inputs: "A redacted subscription export, invoices, renewal dates, and seat usage if available.",
    output: "A spend inventory, evidence-backed savings candidates, and vendor email drafts.",
    review: "Verify costs and contract terms. Cancelling or negotiating needs your approval.",
    prompt: `Review the redacted subscription export and invoices I provide. Ask for the reporting period and available seat-usage data. Do not request passwords or payment credentials.
Build a spend inventory with source references. Flag possible duplicates, unused seats supported by usage evidence, and upcoming renewals. If data is missing, mark it unknown. Separate potential savings from realized savings.
Save the inventory and optional vendor email drafts in my workspace. Ask for approval before contacting vendors, changing subscriptions, cancelling services, or spending money.`,
  },
];
