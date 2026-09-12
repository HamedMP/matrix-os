# Grok Bot research and Matrix product decision

Checked: 2026-09-06. Research/specification only; no Bot installed, third-party code executed, or product capability validated live.

## Recommendation

Build a Templates view inside Chat. A template supplies a bounded job and reviewed context to a canonical Chat; it does not create another conversation system. Start with original **Meeting Brief** and **Sponsorship Reply Draft** templates. Keep live tool execution, recurring workflows, persistent agent management and distribution outside this MVP. See [spec](spec.md), [contract](contract.md), and [implementation tasks](tasks.md).

## Source verification

| Primary source | Current observation | What it establishes / does not establish |
| --- | --- | --- |
| [Eric's announcement](https://x.com/ericosiu/status/2095272180854489337) | Browser read succeeded; generic web fetch returned 403. The post advertises public templates and a choose/context/run flow, linking the article. | Marketing claim, not a software license or measured success rate. |
| [Business article](https://x.com/ericosiu/article/2095207617610256720) | Browser article text and its embedded contract were read; generic web fetch returned 403. Dated September 2. | Author describes nine specialist loops plus a coordinator, seven public examples, narrow authority, caps and proof. No runtime test or source export was performed. |
| [Skills Dojo templates](https://skillsdojo.com/templates) | Nine cards: seven by Eric Siu, two by Shubham Rasal; each links to an x.ai Bot page. | Public workflow descriptions and destinations, not a repository containing seven portable definitions. |
| [Pre-Call share page](https://x.ai/bot/yQRbVJ7aZL2DyPAWulXn7) | Browser read succeeded. Visible name, author, description, terms and `grokbot://app/v1/bot-template?id=...` app link. | Representative web preview; no downloadable manifest exposed in this inspection. Other six configurations were not installed or inspected. |
| [Create and manage Bots](https://docs.x.ai/grok-bot/bots) | Official docs describe account copies containing shared configuration and a desktop-app add flow. | Recipients use their own account; creator computer/logins/history are not transferred. Docs explicitly say shared configuration can be viewed. |
| [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) | Official docs separate reusable instructions from schedule/event triggers and recommend testing a one-time workflow first. | Routines are a separate lifecycle; an MVP template need not implement them. |
| [Third-party Bot terms](https://x.ai/legal/bot-sharing-terms) | Effective August 22; personal-use license and creator-permission requirement for redistribution/re-export remain present. | Public addability is insufficient authorization to redistribute configuration in Matrix. |
| [Skills Dojo terms](https://skillsdojo.com/terms) | July 14 terms retain content ownership and limits on copying/scraping. | Do not mirror the catalog or reuse branding/descriptions as product assets. |
| [MIT skills repository](https://github.com/ericosiu/ai-marketing-skills/tree/502336b416004765b4d37af65a1a00d759be689d) | GitHub API resolved current main to `502336b416004765b4d37af65a1a00d759be689d`; recursive tree has 29 `SKILL.md` files. [License](https://github.com/ericosiu/ai-marketing-skills/blob/502336b416004765b4d37af65a1a00d759be689d/LICENSE) remains MIT. | A separately licensed source artifact. No verified one-to-one mapping to the seven shared Bots. |

The prior September 3 research was useful for locating sources, but its blanket implication that shared configurations cannot be viewed is too strong. The observed web preview is limited; the official product permits viewing/installing shared configuration. Availability inside Grok and redistribution rights are separate questions. Exact reuse needs a portable source artifact plus explicit rights covering that artifact. This spec copies neither hidden configuration nor upstream skill files.

## Workflow inventory and MVP fit

The first two columns summarize the [public catalog](https://skillsdojo.com/templates) and [article](https://x.com/ericosiu/article/2095207617610256720); the final column is Matrix design judgment, not recovered Bot configuration.

| Public example | Job and boundary | Matrix treatment |
| --- | --- | --- |
| [Pre-Call Intelligence](https://x.ai/bot/yQRbVJ7aZL2DyPAWulXn7) | Brief from account/meeting context; follow-up remains a draft. | Best first slice: one meeting, explicit sources, missing-data disclosure. |
| [Sponsorship Deal Desk](https://x.ai/bot/bFrGNsUsXpsIfnCIUEvKy) | Qualify inbound; a narrow standing reply is an exception to human review. | Second original template; omit standing sends entirely. |
| [Outreach Agent](https://x.ai/bot/wexM_NUvEByvLwrnTR_F3) | Capped, evidence-backed outreach queue; hold sending. | Later: lead sourcing, deduplication and contact policies expand scope. |
| [Shortform Scaler](https://x.ai/bot/NA1zDLMoKJZVcjl3mZ2tT) | Candidate clips, human selection, then scheduling. | Later: media ingestion/rendering and destination integrations. |
| [Trial Reels](https://x.ai/bot/HktaB2ID5y5djGCrRAxvf) | Video experiments and performance comparison. | Later: publication and measurement loop. |
| [AEO/SEO Bot](https://x.ai/bot/Jyx1Lg-VzYgyjDc-y-GQi) | Research candidates, select drafts, hold publishing. | Later: search data, CMS and outcome measurement. |
| [Talent Bot](https://x.ai/bot/P2cMMcajyHuHZ4OsZOWfe) | Evidence against a role pack; restrict ATS writes/outreach. | Later: separate recruiting requirements and review. |

The other catalog entries are Mixey and Motion God, by Shubham Rasal; neither is part of Eric's seven. Public examples demonstrate a product pattern, not independently verified business outcomes.

The [MIT repository README](https://github.com/ericosiu/ai-marketing-skills/blob/502336b416004765b4d37af65a1a00d759be689d/README.md) describes workflows with scripts, dependencies, references and optional harness metadata. It requires complete directories for bundled skills and describes local telemetry plus optional remote reporting. Future reuse must pin a commit, retain the copyright/license notice, audit dependencies and outbound calls, replace credential handling with scoped Matrix access, and disable unrequested telemetry. MIT availability alone does not prove runtime compatibility or safe execution. No dependency installation is needed for the two original text-oriented templates proposed here.

## Product discussion recovered

The referenced local task **阅读Discord页面并总结观点** was read through all three pages of turns, including the original Discord request, additional linked examples, the integration-versus-replication discussion, the broader recipe proposal, the later Chat-view clarification, and the licensing correction. It was treated as contextual evidence; old assistant plans and screenshot descriptions were not treated as new instructions or independently verified Discord transcripts.

The sequence matters: initial discussion explored recipes, persistent apps, agent builders and external Grok integration. The user questioned adding a competing Bot object. The later clarification placed agents/templates inside Chat and decoupled them from harness choice. OM-214 explicitly adopts that narrower flow. Therefore this proposal retains canonical Chat identity and does not make a recipe installer, marketing cockpit, shared family app, new store or automation ledger a prerequisite. The family daily brief remains a possible later template; it brings broader source selection and household scope than one meeting.

External Grok integration remains a separate option, not an MVP dependency. The reviewed Bot docs did not establish a supported external start/cancel/event-stream API for controlling these shared Bots. This is an evidence gap, not a claim that no API exists. A future adapter needs documented lifecycle/authorization semantics or an explicitly reviewed spike; do not emulate the Grok UI to run Matrix Chats.

## Current code baseline

Inspected main commit: `802690a28ec5e2134ac1c32c20ae141a12e137d6` (September 6). Paths below are repository-relative.

| Area | Existing implementation evidence | Required change |
| --- | --- | --- |
| Chat identity and admission | `packages/contracts/src/canonical-chat-api.ts`; `packages/gateway/src/chat/{service,orchestrator,repository}.ts` | Strict create/turn schemas have no template binding. Add typed launch metadata and preserve canonical idempotency, revision, run and outbox ownership. |
| Harness abstraction | `packages/gateway/src/chat/provider-adapter.ts`, `provider-catalog.ts` | Shared start/resume/cancel and normalized events exist. No template-specific restricted-execution attestation exists. |
| Provider readiness | `packages/contracts/src/ai-provider.ts`; `packages/gateway/src/ai-providers/service.ts` | V3 remains harness/account/access-source/model truth. Add capability evidence there first, project to Chat; never infer readiness from a template. |
| Connections | `packages/gateway/src/integrations/{registry,registry-expansion,routes,types}.ts` | Catalog includes read/write risk metadata and expanded services. Existing calls use service/action/label; template reads need exact connection-ID binding and per-source constraints. |
| Existing integration access | `packages/kernel/src/tools/integrations.ts`; `packages/integrations-mcp/src/server.ts`; `packages/gateway/src/onboarding/integration-capabilities.ts` | Generic tools and onboarding approvals are useful primitives, not proof of per-template isolation. Do not pass broad integration credentials to a template harness. |
| Custom agents | `packages/kernel/src/agents.ts` | Markdown discovery projects kernel subagent definitions. It is not a harness-neutral managed template API; leave it unchanged. |
| Presentation | `shell/src/components/ChatApp.tsx`; `desktop/src/renderer/src/features/chat/SharedChatSurface.tsx`; `apps/mobile/app/(tabs)/chat.tsx` | Multiple Chat compositions exist. Shared template controller/contracts and shared web/Electron feature components are required. |

Do not repeat the old “only seven integrations” conclusion: the current tree contains `registry-expansion.ts` and spec 118. Catalog presence is still not a live credential/action success test. The proposed MVP intentionally uses only narrowly selected Gmail/Calendar reads and pasted text, regardless of the larger installed catalog.

## Decisions and remaining evidence gates

- Original native templates, not imported Grok configurations or an audited-skills project hidden inside a UI change.
- One-time source snapshot and text drafting first; active harness tool access is deferred.
- Harness-neutral definition does not imply every adapter currently enforces the necessary restrictions. The compatibility gate in the spec must precede product delivery.
- No undocumented SDK behavior is assumed as working. This research did not need an execution spike because it records the restriction as a mandatory implementation gate, with unsupported adapters blocked.
- Yuhan reviews the bounded product scope and restrictions before implementation. This docs/spec PR does not approve product launch.
