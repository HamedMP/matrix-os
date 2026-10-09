# Bot creation and current provider choices

Tracking: [ENG-204](https://linear.app/matrix-os/issue/ENG-204/fixbots-repair-automatic-creation-and-subscription-model-setup). Requester approved the final plan on 2026-10-09. Recommend affected product/provider owners review the managed custom-Bot creation journey and authorization boundary; this recommendation is not an additional implementation gate.

## Goal and journey

Recipe setup must accept the Automatic choice it offers. New agent setup must let an owner explicitly choose a connected ChatGPT subscription and a current supported GPT model for a new managed Bot. Model refresh must preserve all unsaved fields and the explicit funding choice. Saving creates the definition/conversation; it does not run inference or perform integration actions.

An explicit subscription selection creates a managed Bot through server-owned creation provenance and the qualified coordinator runtime. It must not enable ordinary subscription routes on legacy custom definitions. Existing custom Bots retain their saved executor, Full access consent, history and grants. Automatic may use only existing eligible Matrix funding/owner API sources and must never borrow a subscription implicitly.

## Required behavior

1. Validate the exact Automatic contract at the actual startup creation seam, including rejection of extra options and malformed model/source pairs. Keep runtime/source qualification at execution; creation cannot mint funding authority.
2. Reuse durable, owner-scoped Bot creation operations for new managed custom Bots. Custom instructions and selected recipe skills are data, not grant authority. The server resolves and persists a bounded coordinator recipe and exact model/account/grant selection. Client-provided recipe references or route strings cannot supply server provenance. Idempotent retries reuse the created Bot; later open/configuration failures preserve it with safe recovery feedback.
3. Select Connection then Model from one canonical catalog derivation. Expose explicit Refresh models; refresh on opening setup/editor and returning from provider setup. Catalog refresh changes choices, not draft name/description/instructions/recipe, explicit selection or stable create request identity. Revoked selections remain visibly unavailable and cannot be saved/dispatched. No fallback to another funding source and no periodic discovery loop.
4. Run the new managed Bot only in its owned dedicated conversation, through the existing sandbox/broker and live exact owner/model/grant/revision admission. Revalidate queued/retried work and every upstream send. A foreign/archived Bot, stale grant, forged recipe provenance or ordinary-only subscription source fails closed.
5. A managed custom definition must be executable before it is persisted. Reject unsupported Hermes-only skills for these Bots at create/edit boundaries while preserving legacy Hermes recipes. Validate the entire composed system prompt (name, instructions, server-resolved skills, integrations and runtime framing) against the same runtime budget before creation reservation/definition/Chat or an edit write. Rejections retain the previous definition/revision and create no new operation or Chat; the editor must not offer unsupported skills or silently rewrite a draft. Description-only edits and archive-only withdrawal compare supplied executable fields against the saved values, so unchanged full editor payloads do not require installed-skill discovery. Real executable changes and reactivation still validate. If installed skill content later exceeds the prompt budget, runtime composition must reach the existing task-aware guard and persist a blocked task with `policy_denied`, without starting inference.

## Security and wiring

Existing gateway authentication remains personal-principal based; owner IDs never come from client bodies. Existing Agent POST/PATCH ordinary-subscription rejection stays intact. New managed creation uses an authenticated mutating Bot action with streaming body limit and strict bounded schema; `POST /api/chat-agents/managed-custom` creates the definition through the durable instantiation service. Canonical catalog refresh is an authenticated GET using the existing bounded transport. No public route, credential import, secret-bearing DTO, direct worker networking or sandbox relaxation is introduced.

| Operation | Authentication | Boundary |
| --- | --- | --- |
| Canonical provider catalog read/refresh | Existing gateway principal | Owner/runtime catalog and current grant projection |
| Recipe Bot instantiation | Existing gateway personal principal | Exact Automatic or qualified explicit coordinator selection |
| New managed custom-Bot creation (`POST /api/chat-agents/managed-custom`) | Existing gateway personal principal | Strict bounded input, server provenance, owner-scoped idempotency |
| Legacy Agent create/PATCH | Existing gateway personal principal | Retained applicable route/permission and revision checks |
| Dedicated Bot Chat turn | Existing gateway principal plus owned active binding | Current exact definition, execution generation and account/grant/model |

Startup registers shared selection validation and managed creation dependencies before advertising availability. UI submits user-authored fields plus explicit supported selection; service validates before reservation/writes. Related canonical Chat/binding/outbox writes are transactional, use current owner serialization and never adopt unrelated occupied deterministic IDs. Managed custom operations use a server-reserved request namespace, rejected by generic recipe creation. Runtime qualification requires that database provenance, the matching definition creation hash and live owner-scoped direct Chat; an editable recipe reference cannot convert an ordinary operation into a managed custom Bot. Durable creation states preserve failed file/open recovery; retries cannot duplicate definitions or silently change grants.

Catalog orchestration coalesces bounded requests and rejects stale out-of-order or wrong-runtime completion. Errors retain draft and safe state; unknown/provider/path/database messages are not shown. Existing request/body/count/native deadlines and shutdown drains remain in effect. New temporary/buffered data requires bounded size and cleanup; no unbounded request registry or recurring polling timer.

## Surfaces and acceptance

Shared setup derivation applies to Web Canvas, Web Desktop, Electron Desktop and Web Mobile wherever the Agent/Bot setup is present. Native Mobile must consume the same execution/selection semantics where exposed; no surface is declared equivalent based on another surface's capture.

- Red-to-green tests compose real startup Automatic validation with recipe create; invalid Automatic and unavailable admission remain safe.
- New managed subscription creation, persisted model/source, fresh and resumed Bot replies are proven through the qualified runtime. Negative tests cover revocation, stale generation, foreign owner, malformed options, forged provenance and ordinary subscription IDs.
- Current GLM/Sonnet model inventory replaces an initially incomplete snapshot without losing unsaved fields or switching explicit funding. Refresh failure/out-of-order responses and idle request counts are covered.
- PostgreSQL tests cover any new multi-write transaction, conflicting identities, idempotency and rollback.
- Managed custom create/edit tests reject CJK and combined-skills prompt overflow before persistence; accepted prompt boundaries remain executable. Unsupported managed recipe edits are refused before account binding or writes, supported edits succeed, and legacy Hermes skill editing remains supported. Actual full editor payloads must preserve description-only recovery during skill-read failures; changed executable payloads still reject. A resolver-to-runtime regression verifies post-save skill growth records the durable blocked task and safe reason.
- Exact candidate Preview VPS + production Electron Desktop acceptance records client/server commits separately, actual replies and screenshots/recording. Required additional surface evidence is recorded independently; unavailable captures block review readiness instead of being presented as passed.
- Main VPS update/testing is a separate authorized operational step, using only successful immutable releases and preserving owner data. Updating the app is not evidence of Relay configuration repair or completed inference.

## Delivery and exclusions

The primary implementation PR references ENG-204; an independent companion PR contains the unrelated Electron E2E readiness/diagnostic corrections so the implementation stays within the repository file limit. A separate private FinnaAI/matrix-os-site documentation PR explains the new explicit source selection and refresh journey. Human Review precedes requested Greptile/CI merge. Existing financial/configuration activation remains the separate funded rollout's responsibility. No fleet deployment, new grants/budgets, financial waivers, legacy Bot migration or Gmail actions are in scope.
