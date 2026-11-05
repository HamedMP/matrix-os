# Long native question descriptions

Issue: [ENG-438](https://linear.app/matrix-os/issue/ENG-438/fixchat-preserve-long-claude-question-descriptions).

## User outcome

A Claude `AskUserQuestion` with explanations longer than 300 characters displays
the complete choices in a capable client. Selecting an answer resumes the same
native process; a presentation validation failure does not kill the Chat.

The reference [T3 Code Claude converter](https://github.com/pingdotgg/t3code/blob/e313a122452835da330feef41d0b74a4d2eddbeb/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L4569)
retains descriptions without a small independent character cap. Matrix preserves
its resource and safe-display boundaries rather than accepting unbounded data.

## Contracts and limits

- `MAX_USER_INPUT_QUESTIONS_BYTES` is 64 KiB of serialized UTF-8 for an expanded
  question list, including JSON escaping. A single description cannot exceed it.
- Shared contracts preserve every released shape whose option descriptions are
  each at most 300 UTF-16 code units and 1,200 UTF-8 bytes, even when its aggregate
  exceeds 64 KiB. Existing safe-display, field and count bounds still apply. This
  compatibility exception preserves durable reads, exports and other providers;
  it does not migrate or truncate stored data.
- New Claude admission independently checks both the original native question
  list and the validated canonical projection against 64 KiB before retaining
  either. The shared-reader compatibility exception cannot bypass admission.
- Existing native question/option counts and question, header and label limits
  remain. Sensitive-question redaction and safe-display validation remain.
- Invalid, unsafe or over-budget question content receives an explicit native
  tool denial before a pending card/timer is created. The process can ask a
  supported question afterward. A failed denial write remains a transport error.
- Pending-request limits, expiry, cancellation, owner/run fencing and answer
  idempotency are unchanged. No validation failure implicitly approves a tool.
- Stored question descriptions, original native question keys and answer labels
  remain complete. Display projection must never rewrite those values.

## Mixed-version transport

`questionDescriptionVersion=1` independently opts into expanded descriptions.
`inputVersion=1` stays unchanged. Updated shared clients advertise both; an
older gateway ignores the new capability and continues its previous protocol.
Native Mobile uses `chatMessageVersionUrl` for detail reads, turn admission and
event streams so its independent transport cannot drift from Web/Electron.

Absent or `questionDescriptionVersion=0` returns the released 300-code-unit
description projection, including a nonblank fallback and no split surrogate
pair. Option labels and returned answer values are unchanged. The projection is
applied to HTTP responses and SSE content frames, never repository/outbox data.
Unsupported or duplicate description capabilities are rejected before opening a
stream or invoking the Chat service.

## Authority and persistence

No endpoint, database table, migration or credential source is added.

| Existing boundary | Authority / invariant |
| --- | --- |
| `GET /api/chats/:chatId` and existing Chat response routes | Existing authenticated owner/project scope; capability changes presentation only |
| `GET /api/chats/events` | Existing authenticated event stream and subscriber lifecycle |
| `POST /api/chats/:chatId/runs/:runId/inputs/:requestId` | Existing body limit, owner/run/request fencing and validated answer contract |
| Native stdio question response | Only the matching pending request may receive the original question's selected answer |

The raw native payload stays process-local. Canonical events remain the durable
source of truth; existing transactions and terminal-state writes are unchanged.

## Acceptance

| Start / action | Observable result | Evidence boundary |
| --- | --- | --- |
| Native question with 380/355-character explanations; select one answer | Full card, same stdin response and successful run completion | Real Claude adapter/controller/supervisor with synthetic transport; no provider call |
| Expanded list at/above 64 KiB, multibyte or escaped text | Boundary accepted; expanded overflow rejected; native original or projected overflow explicitly denied | Shared contract and native-controller tests |
| Released 8-question/10-option lists with 300-code-unit CJK descriptions, already in JSONB | Pending input, detail, export and both wire variants preserve the full prior-valid shape above 64 KiB | Real repository and shared-client contract regression |
| Malformed or unsafe question; subsequent supported question | No card or implicit approval for rejected input; process remains usable | Controller denial and native adapter regression |
| Released and capable clients read one persisted long question | Parseable legacy descriptions or complete current descriptions; storage unchanged | Contract and real HTTP/SSE route tests |
| Electron Desktop question and answer | Full long explanations visible; answer continuation stays in the existing Chat/run | Existing deterministic Electron E2E, with screenshots outside Git |
| Web Desktop / Web Canvas | Same shared question semantics and complete descriptions | Exact-source runtime evidence recorded with the PR |
| Native Mobile detail, turn admission and SSE | Shared capabilities retain full question text; existing answer labels remain unchanged | Native Mobile transport/projection and input-form regressions; device visual evidence is separate |

The fixture is independently worded and contains no private transcript, account
details or operational access data. Production provider/model inference and a
deployment are separate acceptance work, not implied by fixture results.

Public user guidance is maintained in the separate `FinnaAI/matrix-os-site`
documentation PR linked from the implementation PR.
