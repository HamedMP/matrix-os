# Guided project setup in Chat

Created November 22, 2026. The requester approved this specification for implementation on November 22, 2026.
Branch `codex/project-chat-setup-spec`.

## Goal and design authority

A personal project owner can tell the AI what the project is for, explain working preferences, create or import a reusable skill, and optionally connect tools through a short conversation. The owner reviews the proposed Markdown before saving. The project overview then shows the saved configuration, and the owner can use a saved skill in Project Chat.

The baseline is the guided Project Chat design reviewed on November 12, including the correction to use the existing Chat message presentation. Assistant replies use ordinary left-aligned body text without a repeated “Matrix” label or a display heading. User replies use the existing user-message bubble. Suggested answers and setup actions sit below the corresponding reply. The existing composer accepts free text throughout. Team-review examples and demo Chats use English. The implementation follows existing localization conventions.

Design references are the [guided setup board](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=2471-15695), [clickable flow](https://www.figma.com/proto/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?page-id=1164%3A20441&node-id=2471-15699&scaling=scale-down), [Skill conversation](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=2471-16373), and [MCP conversation](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=2471-16813). The connector denied file access and Desktop Bridge was disconnected on November 22. This draft uses the previously reviewed design and retained design notes. Reopen the board before visual implementation to identify subsequent changes.

[Hamed’s feedback](https://matrixos.slack.com/archives/C0C459830FJ/p1794470298427819) asks for plain-language project guidance, Chat authoring, Markdown review, skippable onboarding, and visible saved skills. The existing [project context feature](../2691-project-agent-context/spec.md) and [instruction discovery evidence](../../docs/dev/project-agent-context.md) are the implementation baseline. Existing feature tracking is [ENG-442](https://linear.app/matrix-os/issue/ENG-442/add-project-agent-configuration-to-desktop-and-web) and [PR #3244](https://github.com/HamedMP/matrix-os/pull/3244). Implementation tracking is [ENG-538](https://linear.app/matrix-os/issue/ENG-538/guide-personal-project-setup-through-project-chat). Draft PR #3572 now carries the approved specification and its implementation.

Source inspection was refreshed against `main` at `68ad9d637e1` on November 22. General computer onboarding in [spec 635](../635-guided-onboarding/spec.md) has a separate entry and purpose. This feature starts from a project. Reuse shared Chat and connection surfaces where their existing contracts apply.

## Scope

The first delivery includes personal-project setup on Electron Desktop, Web Desktop, and Web Canvas. The primary checkout owns the generated files. Electron Desktop also offers setup after successful project creation. The project overview on all three surfaces exposes an entry to start or resume setup.

Setup writes through shared/collaboration contexts, worktree-specific setup, direct skills.sh installation, multi-file skill packages, automatic project-only MCP grants, and a new cross-runtime instruction injection policy require follow-up designs. Native Mobile and Web Mobile are outside this delivery’s acceptance scope, as requested. Files inline naming and rename remain a separate recorded follow-up.

## User scenarios and acceptance

### 1. Start, skip, or resume setup

The owner opens a personal project and chooses **Set up with Chat** or **Skip for now**. Electron Desktop offers the same choice after project creation. Setup opens in the ordinary project-bound Chat surface.

1. Showing the offer creates no Chat history item, model run, or configuration file. Selecting Skip returns to the project overview and leaves setup available later.
2. The first explicit suggested or typed answer creates or binds the setup conversation to that project. Start and resume reuse the unfinished setup conversation for the same scope.
3. The assistant asks one question at a time and accepts either a suggested answer or a free-text reply. Subsequent replies remain in the same project Chat.
4. Leaving an unfinished conversation preserves its accepted answers and unsaved draft. Returning under the same account, computer, project, and primary checkout resumes that draft.
5. Switching account, computer, project, or checkout removes the old draft from the visible context and invalidates its save confirmation. Late responses cannot appear in or save to the new context. The original scoped draft can be resumed after its authority is revalidated.
6. A project with existing Chats retains its Chat cards and navigation. The setup entry and configuration viewer remain in the project overview’s main region.

### 2. Describe project guidance

The assistant first asks what the project is for, then how it should work. For example, the owner answers “A portfolio website” and “Keep changes small, run the relevant checks, and ask before publishing.” The assistant drafts project guidance from those answers.

1. The draft reflects the owner’s answers and stays editable through the existing Markdown editor and conversation.
2. The assistant requests clarification when an answer is insufficient to draft useful guidance. A provider error or denied run keeps previous accepted answers available and offers retry through the existing Chat path.
3. The review shows the complete proposed Markdown and destination files. Changing an answer refreshes the proposal and invalidates confirmation of the earlier version.
4. New guidance is presented under **Guidance for AI in your project**, with a brief explanation that saving creates `AGENTS.md` and a `CLAUDE.md` companion.
5. Existing independent instruction files remain accessible under **Advanced** through exact file actions. The owner chooses the target explicitly before editing them.

### 3. Create, import, or skip a Skill within Chat

The assistant asks what the owner does repeatedly. The owner can choose **Create a skill**, **Import SKILL.md**, or **Skip for now**. A new skill requires a description of what it should do before the assistant drafts it.

1. Creating “release-check” asks for the checklist or desired outcome and produces reviewable Markdown with a name, description, and instructions. It uses the existing skill validation and project destination conventions.
2. Import opens the existing local Markdown picker. The owner sees the selected filename, skill name, purpose, and complete Markdown before confirming its inclusion in the setup proposal. Importing keeps the content intact.
3. The existing installed-skill picker remains accessible as a secondary action and uses the same preview and copy contract. It transfers the selected manifest into this project on explicit save.
4. Copy and import transfer Markdown only. If a manifest needs scripts or assets, explain that dependency before confirmation. Setup does not run installers or copy unrelated files.
5. Skip advances to the MCP question and creates no skill. Revision can add or remove the skill before save.
6. After save, the skill appears in this project’s configuration viewer and next opened slash picker. Selecting it attaches the exact project-relative manifest to the draft using the existing skill selection path. Sending uses existing runtime file access and approvals.
7. An unrelated project never receives the skill, its selection, or setup answers. A failed inventory refresh shows a retry state while retaining the successful save result.

### 4. Connect or skip MCP tools

The assistant asks whether connected tools would help. The design uses Linear as an example. The owner may name a service, choose **Connect Linear**, or skip.

1. The connection action opens the current computer’s existing Custom MCP Settings and authorization flow. Returning restores the same project setup Chat.
2. The Chat shows **Authorization pending** until an authoritative Settings read confirms the connection. Opening Settings, returning from OAuth, or receiving a success-like model reply alone cannot mark it connected.
3. After confirmation, identify the service as connected on the current computer. Use the existing connected-server identity and policy. Project declarations remain visible as file metadata.
4. Cancellation, failure, unsupported services, or a still-pending connection leaves a clear action to retry in Settings or **Continue without connecting**. An optional connection never blocks saving reviewed guidance and a skill.
5. MCP authorization takes effect through Settings when the owner completes that flow. The review explains that saving project files is a separate action. Skipping later or discarding a draft does not revoke an existing Settings connection.
6. Tool invocation follows the existing runtime discovery, account selection, consent, and approval policy. A connected server can still be unavailable to the selected runtime or lack permission for an action. Report the observed state accurately.
7. Credentials, OAuth tokens, and executable MCP installer commands are excluded from project guidance, generated manifests, and setup summaries. Route authorization through the existing Settings UI.

### 5. Review, save, and use the result

The review summarizes guidance, the optional skill, and the observed MCP state. The owner can revise answers, inspect the full Markdown, or choose **Save project setup**.

1. The review binds its proposed content and destinations to the authenticated account, computer, immutable project ID, and primary checkout. Save revalidates that scope and the reviewed proposal.
2. Saving creates only confirmed files at allowlisted project-relative paths. Saving the draft never enables a tool or grants an MCP permission.
3. Each file has an explicit saved, already-present, conflict, or failed result. A partial result preserves successful files and unsaved Markdown. Retry rereads destinations, recognizes matching content, and asks for renewed review when a destination changed.
4. After success, the overview displays saved guidance and any skill. Exact file actions open the existing editor. Future edits refresh the project’s inventory and skill picker through existing reads.
5. A normal subsequent Project Chat can select and use the saved skill. An actual runtime result verifies that the selected manifest was read under the admitted project root.
6. The saved-files receipt describes persistence. Any claim that guidance influenced a run requires evidence that the selected runtime actually read it. The explicit read-and-use route remains available under normal workspace permissions.

## Functional requirements

| ID | Required behavior | Acceptance source |
| --- | --- | --- |
| FR-01 | Offer start, skip, and resume in the project overview and after Electron project creation | Scenario 1 |
| FR-02 | Reuse ordinary Project Chat presentation, composer, identity, and message ordering | Scenarios 1–4 and Figma references |
| FR-03 | Ask project purpose, working preferences, Skill, and MCP questions sequentially with suggested and typed answers | Scenarios 2–4 |
| FR-04 | Retain a scoped unfinished draft and invalidate stale confirmations | Scenarios 1 and 5 |
| FR-05 | Review complete Markdown and revise accepted answers before save | Scenarios 2, 3, and 5 |
| FR-06 | Create shared guidance through `AGENTS.md` and a reviewed `CLAUDE.md` companion, preserving independent existing files | Guidance ownership table |
| FR-07 | Reuse Skill creation, local import, installed copy, inventory, and slash selection | Scenario 3 |
| FR-08 | Reuse computer Settings for MCP and distinguish skipped, pending, connected, and runtime availability | Scenario 4 |
| FR-09 | Revalidate immutable owner/project/checkout authority on every content read and write | Authorization matrix |
| FR-10 | Report per-file save outcomes, preserve drafts after failure, and support a safe retry | Scenario 5 |
| FR-11 | Keep equivalent setup actions and state semantics on the three scoped presentations | Scope and verification matrix |
| FR-12 | Label runtime behavior from actual discovery evidence and preserve current permissions | Runtime contract |

## Guidance ownership and save rules

| Current checkout state | Review and save behavior |
| --- | --- |
| Neither root file exists | Create the approved `AGENTS.md`, then exclusively create `CLAUDE.md` containing the reviewed relative `@AGENTS.md` import |
| `AGENTS.md` exists and `CLAUDE.md` is absent | Show the current guidance, open its exact editor for changes, and offer the missing companion only after review |
| Only `CLAUDE.md` exists | Show the existing file and preserve its content. Offer an explicit reviewed `AGENTS.md` creation where useful. Preserve the independent Claude file |
| Both files exist | Show existing guidance with exact advanced file actions. Any existing-file edit uses the editor’s existing save and conflict contract |
| An override or nested Claude file exists | Surface its presence and exact file action. Explain that it can affect the selected runtime’s guidance |
| A target changes, appears concurrently, or becomes inaccessible | Preserve the current file and draft. Reload state and require fresh review before retrying that target |

The two-file create operation has observable per-file results. Publish `AGENTS.md` first. Keep a valid canonical file if companion creation fails. Existing files use the current editor authorization and conflict behavior. Exclusive creation is enforced server-side, and a double click or retry must preserve existing content.

The current project create route caps non-skill content at 8,192 characters and Skill manifests at 64 KiB of UTF-8. Initial setup respects those limits and validates them before offering Save. An oversized proposal remains available for revision or the existing editor flow. Raising those limits requires an explicit contract change and resource tests. A new cross-file overwrite or migration transaction is outside this create flow.

## State, ownership, and runtime wiring

A **setup draft** contains accepted answers, the current question, proposed files, source and destination metadata, and per-file save results. It belongs to the existing project Chat and persists through existing owner-controlled Chat storage. Add a narrow typed draft representation if required. Keep file contents authoritative after save and avoid a separate configuration registry.

A **review confirmation** identifies the draft revision, reviewed content, scope, and expected destination state. It expires on a revision or scope change. Runtime identity changes also invalidate any runtime-specific selections and availability claims. Accepted project answers may remain within the same valid project scope.

A **connection observation** references the existing Settings connection by its stable identity and current computer. Setup stores no credentials and creates no project grant. Recheck connection state on return and before presenting a connected result.

The runtime path is project entry → ordinary project Chat → admitted project/root and existing runtime → accepted answers and proposed files → explicit review → authenticated project Files creation → scoped inventory refresh → normal project Chat skill selection and runtime read. Shared helpers own scope derivation and state transitions across presentations.

The November 22 baseline documents native Codex project instruction discovery, suppressed automatic context loading in canonical Claude/Pi paths, and other version-dependent runtimes. This spec preserves those launch policies. A `CLAUDE.md` companion works only where the runtime loads it and supports its import. MCP connection state and successful file creation cannot prove instruction loading. Requalify the actual runtime version before acceptance and update the evidence if its behavior changed.

## Authorization and API reuse

All operations remain private. Existing authentication, owner/project admission, immutable identity, and Files permissions apply at the server boundary. A personal owner keeps existing authority over their own primary checkout when files are shared externally. Shared/collaboration Chat contexts and members receive no setup write entry or authority. A model-generated project ID, path, or connection state grants no authority.

| Operation or existing route | Authentication and authority | Setup use |
| --- | --- | --- |
| Canonical project Chat create/read/turn | Authenticated owner with existing Chat and execution-root admission | Ordinary transcript, answers, and scoped draft |
| `GET /api/projects/:projectId/agent-context` | Request principal and active personal project resolved by immutable ID | Bounded inventory and post-save refresh |
| `GET /api/projects/:slug/files-location?projectId=…&file=…` | Existing owner and exact project file location validation | Open the reviewed file through the existing editor |
| `POST /api/files/touch` with `projectId` and `projectFile` | Existing Files write authority, owner project admission, pinned checkout, and write-time revalidation | Exclusive creation of reviewed guidance and Skill manifests |
| Existing Files content read/write | Existing owner/project authorization and save/conflict checks | Full Markdown review and existing-file edits |
| `GET /api/settings/skills` and `/api/settings/skills/manifest?path=…` | Current-computer Settings authority and allowlisted installed roots | Explicitly selected installed-manifest preview and copy |
| Existing Custom MCP Settings, OAuth, and connection reads | Existing authenticated Settings ownership and explicit connection consent | Connect and observe state on the current computer |
| Existing runtime MCP discovery/call broker | Existing runtime/run authority, connection ownership, and tool approvals | Subsequent real tool usage |

The focused setup API below supplies the durable draft extension missing from existing strict Chat metadata. Existing Chat creation, transcript storage, admission, Files, Skills and Settings remain the reused operations. The [technical plan](plan.md) records the wiring and write boundaries.

Boundary checks include owner/project admission after archive/delete, root movement or replacement, symlink and nonregular file rejection, allowlisted relative paths, actual byte limits, malformed frontmatter, and body limits on mutations. Reads and requests are bounded and cancellable. Revalidate late results before applying them. Long-lived draft caches and connection polling require a cap, expiry or eviction, and cleanup on navigation and shutdown.

Imported Markdown is untrusted content. Render it through the existing safe Markdown path. Keep credentials out of logs and public documentation, allowlist client error text, and preserve private/no-store file reads. Tests must cover a stale model response proposing a different project or unsafe destination.

## Verification and measurable outcomes

Write failing tests before product code. Extend current project context, Files, and Chat tests where possible. Verify shared state rules once through shared helpers, then cover each surface’s entry and handoff wiring.

| Gate | Required evidence |
| --- | --- |
| Guided conversation | Suggested answers, free text, revision, Skill create/import/skip, and MCP connect/pending/skip reach the corresponding review state |
| Persistence | Same-scope reopen resumes accepted answers. Scope switches, stale results, archive/delete, and changed checkout cannot apply an old confirmation |
| File safety | Empty/existing files, each partial failure point, concurrent creation, double save, unchanged-content retry, malformed/oversized input, and symlink/root replacement preserve owner data |
| Authorization | Unauthenticated, unrelated owner, shared-member, and worktree contexts cannot use primary-checkout setup writes |
| Project isolation | Project A’s answers, Markdown, skill inventory, slash selection, and queued turns never appear in Project B. MCP remains visibly computer-scoped |
| Skills regression | Installed copy, local import, exact editor actions, existing slash selection limits, queued selections, and draft preservation continue to work |
| MCP authority | Settings return without authoritative success stays pending. Cancellation and denied calls preserve existing connection and approval policy |
| Actual runtime use | In a disposable project, save unique guidance and a skill, select the skill in an English Chat, and capture the admitted root, manifest-read evidence, and resulting response. Distinguish automatic discovery from an explicitly requested read |
| Visual flow | Electron Desktop, Web Desktop, and Web Canvas show the reviewed Chat typography, readable choices, long Markdown, correct editor focus, and a retained setup draft on Settings return |
| Resource regression | Use the previously validated bounded Electron packaging path. Run one test client, observe memory before/during/after the flow, and stop/review growth if the client becomes unstable. Record actual measurements |
| Delivery | Focused tests, type checks and relevant CI pass. Attach screenshots or a short English demo from the matching PR version |

Acceptance requires all scoped branches to reach an accurate review and saved state, zero file or model side effects from the initial Skip, zero cross-project draft/write leakage in isolation tests, and a real subsequent Chat use of the saved skill. Provider or auth blockers remain explicit unclosed gates. Existing runtime qualification is evidence for the baseline and must not be reported as a new live pass.

## Delivery and review decisions

1. Review this spec against the Figma board once file access is restored. Link a verified follow-up ENG issue to the implementation PR.
2. Write the technical plan and focused test list against current source, including the durable draft contract and save orchestration. Any undocumented SDK assumption requires a bounded spike first.
3. Implement from an isolated worktree, reuse shared Chat/Files/Settings capabilities, and verify with the prescribed Trellis implementation and check agents.
4. Use Fast CI where available. Verify a matching Private Preview on the three scoped presentations and capture the actual flow with bounded Electron memory monitoring.
5. Deliver a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` covering setup, Skill usage, MCP computer scope, conflicts, and runtime discovery limits. Match the existing project guide.
6. Keep implementation and documentation PRs reviewable with test/Preview evidence. Merge and production rollout follow separate explicit authorization.

Product and security boundaries recorded for review are computer-scoped MCP through existing Settings, manifest-only Skill import, owner-primary-checkout setup writes, and preservation of current instruction-loading policy. Direct skills.sh installation, bundled assets, project-only tool grants, and automatic injection need separately reviewed contracts. Files inline creation naming and click-to-rename remain a separate follow-up from Hamed’s Figma comment and the November 12 request.

## Concrete setup API contract

| Private operation | Request and response | Authority and consistency |
| --- | --- | --- |
| `GET /api/projects/:projectId/setup` | Return `{ draft }`, where an unfinished matching setup may be null | Existing authenticated personal owner and revalidated active primary project/root, private no-store |
| `POST /api/projects/:projectId/setup` | First explicit purpose answer with `clientRequestId`, `answer`, and optional canonical `currentSelection`; return `{ draft, record }` | Same owner/root authority, bounded body, server-side singleton and request idempotency. Create the draft, canonical Chat and known transcript messages in one transaction |
| `GET /api/chats/:chatId/project-setup` | Return the currently authorized `{ draft }` | Existing owned canonical Chat plus the matching active primary project/root. Shared or moved contexts fail closed |
| `PATCH /api/chats/:chatId/project-setup` | `baseRevision`, `clientRequestId`, and one validated action; return the current draft and canonical record as needed | Same owner/root admission, bodyLimit, typed per-action validation, revision CAS in the write statement, transcript/outbox and draft writes in one transaction |

The draft identifies its Chat, immutable project, server-resolved primary root, revision, current question message, accepted answers, staged Skill, proposed files and per-file results, MCP request/skip choice, generation state, and update time. Computer scope derives from the routed runtime. Keep it in a Chat-owned PostgreSQL row with a foreign key to the canonical Chat. Final project files remain configuration authority. Never repurpose the strict public userState or shellState fields.

The discriminated action set covers an answer, create-or-skip Skill choice, staged Skill Markdown, connect-or-skip MCP choice, answer revision, reviewed file content, review preparation, generation, generation synchronization, and explicit save. Known questions and accepted answers enter the ordinary canonical transcript through server-validated transitions. The API exposes no arbitrary assistant-message append. MCP connected status comes from an existing authoritative Settings read.

Draft generation uses the existing canonical model admission with an enforced supported read-only review/plan mode. A model receives only the accepted answers and requested proposal format. Its bounded result is validated before becoming a proposed file. Imported Markdown remains untrusted content. A provider or runtime without a qualified safe drafting mode shows unavailable drafting with the accepted answers preserved. A prompt asking the model to avoid writes is insufficient enforcement. The normal user-selected permissions continue to govern subsequent ordinary project work.

Conflicts return a safe conflict state and require a reload/review. Missing or inaccessible resources share existing not-found behavior. Missing dependencies and unavailable drafting return safe unavailable errors. Retries with the same request identity recover the accepted outcome and cannot duplicate canonical Chats or transcript messages. Persistence, request history, and generated content are bounded.
