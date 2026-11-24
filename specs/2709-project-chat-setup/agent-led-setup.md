# Agent-led project setup in Chat

Status: approved for implementation on November 24, 2026

Tracking: [ENG-538](https://linear.app/matrix-os/issue/ENG-538/guide-personal-project-setup-through-project-chat)

Stack: [#3628](https://github.com/HamedMP/matrix-os/stacks/3628), with this layer based on [#3573](https://github.com/HamedMP/matrix-os/pull/3573)

## Outcome

A user can describe what they want in their own words. The Agent uses the project context and their answers to decide what it still needs to ask, propose useful configuration, and explain the result before the user saves it. The same goal remains understandable whether the user replies once with several requirements or adds them across a conversation.

The existing design uses Chat for presentation but the application chooses the question order and most options. The transition records an answer for the current field and advances to the next fixed phase. The Agent only drafts Markdown at the end. Keep the approved Chat presentation and configuration operations. Replace the assumption that every project follows the same interview.

## User journey

| Moment | Agent behavior | Existing user controls |
| --- | --- | --- |
| Start | On **Set up with Chat**, ask a relevant opening question and optionally suggest up to three useful starting answers. Use the project name and available description. For a generic name, ask an open question. | Ordinary project Chat composer, suggested answers under the reply, and Skip. Opening the project home or skipping before Start creates no Agent run. |
| Understand the project | Interpret the entire answer against known context. Ask the highest-value missing question. Accept answers that cover purpose, rules, repeatable work, and integrations together. Reuse confirmed information and ask for clarification when it would change the configuration. | Typed or suggested answers enter the same transcript. A user can correct a prior answer or skip an optional topic. |
| Skills | Recommend a concrete Skill when a repeatable task emerges, including its trigger and expected result. Ask what is missing. If an existing project or installed Skill is relevant, explain why and offer the existing choice or import action. | Existing skill chooser, manifest import, Markdown editing, review, and explicit save. The agent may propose a draft, including a revision requested in Chat. |
| MCP | Identify the user’s need before recommending a service. Use current computer connection facts and the supported catalog. Explain when a connection is already available, or guide the user to Settings when authorization is needed. An unknown service stays unconfirmed. | Existing MCP Settings, owner OAuth, connection check, and tool approval. The user can continue with a pending connection or skip it. |
| Review | Summarize the requirements the Agent heard and show the actual proposed files. Let the user revise the plan in plain language, including correcting an inference. Stop asking when sufficient information is available. | Exact Markdown review, file conflict handling, and explicit **Save project setup**. Save status comes from the actual file write. |

Example. In **Release Notes**, the user says, “Draft customer release notes from Linear. Ask me before publishing.” The Agent can record the purpose and publishing constraint, acknowledge the Linear requirement, and ask what should count as ready for the release checklist. In **Store Operations**, a different answer can lead to a shift-handoff Skill and no MCP recommendation. Entering all the requirements in one reply may take either project directly to review.

## Focus within each Chat turn

- Lead each active turn with one short question or next step. Offer at most three short, complete replies or actions at a glance. Keep the ordinary composer available for an answer in the owner's own words or a correction to earlier answers.
- Ask the Agent to return a plain lead of up to 100 characters and up to three complete suggestions of 32 characters each. Omit optional suggestions that cannot fit as written and keep free-text input available. Put necessary explanation in the lead or in Review. Accept bounded legacy replies and retain their full transcript. Both renderers show the usable short question where possible and keep the actual question accessible if it cannot be shown compactly.
- Keep full Markdown in Review. Saving and leaving setup remain explicit actions. A failed turn retains the accepted answer and draft, and Retry processes that answer without creating another user message. The existing Settings handoff remains the place to authorize MCP.
- Keep the project breadcrumb and outlined **Cancel setup** button above the scrolling transcript throughout an active setup. At narrow Chat window widths, keep the header, messages, and composer inset from the pane edges and keep the cancel button fully visible with the sidebar open.
- Verify both renderers with two project contexts, a correction, a failed turn and recovery, explicit saving, and Skill selection in a new project Chat. Record which runs used test fixtures and which used an authorized provider.

## Review, resumption, and availability

- Full guidance is ready for review when the Agent can summarize the project purpose and work preferences from the owner's answers. The owner can say they have no special rules. Ask a follow-up only when a missing answer would change the proposed guidance. Skill and MCP are optional. If the user explicitly wants only one configuration item, review just that item and leave the rest undecided.
- Use the currently selected compatible model. If it is unavailable or cannot run with the required tool restrictions, preserve the typed answer and draft. Offer model choice, retry or Skip. Do not silently switch account, provider, or billing source. Qualify the existing eligible providers individually. Report any runtime that cannot safely support the interview.
- Preserve existing setup conversations, user answers, scoped drafts and file receipts from #3573. A user deliberately continuing an unfinished setup resumes at the next meaningful question based on known answers. Saved setups do not restart, and opening the project home never starts a model run.
- Record accepted answers once before admitting their corresponding Agent turn. Bind the projected result to project, owner, computer, checkout, and draft revision. Limit each answer to one active turn and offer retry after a failure without repeating the user bubble. Ignore late results for a superseded turn.

## Context and authority

- Supply the owner-scoped project name and description, import type and safe repository identity when present, and bounded facts from the existing project Skill, instruction-file and computer MCP inventory. Preserve the difference between the current connection and the user’s desire to use it. Further repository content falls outside the initial suggestion context. Agent input treats imported metadata and user text as data.
- Keep accepted user decisions distinct from Agent inferences. A suggestion is optional. Buttons submit answers or invoke existing app actions only after a user interaction, with stable target identifiers validated by the gateway. The application determines availability, connection state and permission. The Agent cannot authorize services, mark them connected, add credentials, write files, overwrite instructions, or publish.
- The setup interview uses a restricted, scoped Agent run. Resolve the selected provider through the existing Chat catalog and enforce its setup tool permissions at run admission. Fail closed for runtimes that cannot supply those constraints. Provider eligibility and the exact restricted tool surface must be verified before release.
- Keep existing Chat appearance in Electron Desktop and Web, including the composer, assistant messages, and choices below their reply. Render the approved question or summary. Keep the internal instructions and structured payload out of Chat.

### API and compatibility

| Existing route | Request authority | Agent effect |
| --- | --- | --- |
| `GET /api/projects/:projectId/setup` and `GET /api/chats/:chatId/project-setup` | Authenticated owner of a personal project and its primary checkout | Read the current draft. |
| `POST /api/projects/:projectId/setup` | Same owner and checkout, with the selected Chat model and an explicit setup start | Start one interview or resume the same draft. |
| `PATCH /api/chats/:chatId/project-setup` | Same owner and checkout, bound to the current draft revision and an action-specific schema | Submit or retry an answer, read a validated reply, or use an existing explicit configuration action. |

The response adds an optional interview field. Existing saved drafts stay readable. Validate the full interview with a matching Gateway and client because older clients parse setup responses strictly.

Claude Code supports the interview through a fresh, text-only process. Matrix AI Pi supports it through the existing broker with an empty tool set. Codex and other runtimes need a verified tool-free execution path before becoming eligible. A user can choose a compatible model and retry the same answer.

## Approaches

1. **Recommended: one resumable Agent turn per answer.** Reuse canonical Chat admission, model selection, transcript and the project-owned setup draft. Each turn produces the next question or a review proposal using a scoped, validated result. Turn boundaries permit retry or returning from Settings without relying on a live model process. The product can keep saving, connector actions and audit history in their current paths.
2. **Long-lived Agent session using native questions.** This also lets the Agent direct the conversation. Native question projection already exists, but process timeouts, cross-provider differences and resuming after Settings make this a larger change.
3. **Agent wording on the current sequence.** This would improve suggested examples, while the application would still decide what information each reply contains and ask every phase in order. It does not meet the requirement to use the user's answers to decide what to ask next.

The requester approved approach 1 in a follow-up stack layer. The provider spike will verify the restricted execution and rendering path before live acceptance.

## Acceptance

1. Two projects with different names and context receive materially different first questions or suggestions from real Agent runs. An ambiguous name gets an open-ended question. Project-view entry and pre-Start Skip make zero model calls.
2. A free-text answer that gives purpose, working rules, repeated work, and tool intent visibly changes the next Agent turn. Combinations already answered are not asked again. A later correction updates the draft and invalidates any older save confirmation.
3. Skills are recommended from the real project context and the user can inspect the generated or imported Markdown. The Agent recognizes a suitable existing Skill or explains why none is needed. It cannot activate or install it without the existing user action.
4. MCP guidance differentiates already-connected, authorization needed, and unknown without assuming Linear for every project. Verify non-Linear or no-tool scenarios and the existing Linear authorization and real read-only invocation in a normal project Chat.
5. Setup remains resumable. A disconnected model, invalid result or timeout preserves the last committed user answer and offers retry or Skip. Duplicate submissions, switching project/account/computer and late model responses cannot duplicate turns, write files, or publish another project's suggestions.
6. Drafts are visible in the current project only. Files appear after explicit review and save. Signed-out, shared projects, stale checkout, and unauthorized writes remain denied. Existing files are preserved.
7. Verify Electron Desktop and Web against the same supported runtime with a completely recorded real flow. Include two distinct projects, an imported-repo case, a short path where the user answers several questions together, and a cross-project isolation regression.
