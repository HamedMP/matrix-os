# Chat-defined Slack summary rules: local qualification

## Scope and evidence classes

This local follow-up adds owner Chat-managed executable policy to the existing enrolled-source and restricted-summary path. It does not activate a real policy or change any Slack subscription, OAuth scope, installation, model funding, Preview runtime or production setting.

| Evidence | What it can establish |
| --- | --- |
| Strict contract and intent tests | Supported operations and bounded affirmative instruction grammar; ambiguous/contradictory requests remain unsaved. |
| Real PostgreSQL canonical HTTP tests | Positive original/queued owner provenance, atomic persistence, restart/promotion and non-upgrade after edits/replays/internal inputs. |
| Native tool/broker tests | Tool schema, declared effect, capability/checkpoint enforcement, owner policy transaction and committed receipt. |
| Signed event and actual Pi/broker tests with synthetic providers | Ordinary messages and owner mentions can execute a saved matching policy through existing routing, with one inference and private output. |
| Live Slack / paid model / Matrix UI | Not exercised by this local follow-up. Earlier native manual-read acceptance belongs to its previously installed commit. |
| Remote CI / review / release | Not qualified for an unpushed local commit. No merge or deployment. |

The interactive model's ability to choose and complete the rule tool from a real user's conversation, and the matching English configuration/result UI, still need exact-version runtime acceptance. A scripted native invocation does not establish that user journey.

## Qualified local results — November 20, 2026

- **9 focused suites / 72 tests passed**, zero skips, exit 0. Node 24.14.0 and pnpm 10.33.4 from the repository Flox environment. Stateful origin, rule, native broker, lifecycle and signed/Pi fixtures use PostgreSQL 16; contract/grammar assertions are pure unit tests. The actual automatic Pi/broker path uses synthetic provider HTTP and verifies both ordinary-message and owner-mention triggers, exact fresh trigger text, English/private output, one inference, empty tools and zero Slack writes/reactions/destinations.
- **44 related regression suites / 922 tests passed**, zero skips, exit 0. These include existing Slack/native-read/summary, Chat, integration and routine behavior. This lane is **mixed PostgreSQL and PGlite**: setting a PostgreSQL URL does not change every fixture. Do not describe all 922 as PostgreSQL tests.
- Canonical **eight native TypeScript targets passed**. Gateway, platform, contracts and bot-runtime release TypeScript 5 checks also passed; gateway was repeated after the final parser correction.
- The initial incomplete runs using the ambient Node 25 / pnpm 9 environment were stopped and excluded. Final qualification used the pinned Flox toolchain. Expected negative-case stderr and an existing missing node-cron sourcemap warning are not failed assertions.
- The automatic-summary test runs the real Pi loop. Rule setup exercises the native model-facing tool and real gateway broker/registry/checkpoint/service, while its client/provider choices are scripted. No real interactive model selection, Slack end-to-end or UI acceptance is claimed.

Source/test fingerprint before the local commit: `cce202754b905decdd2f892936eddcdefba1a7685282f96a1f720af4dc9580ca` across 53 changed TypeScript files. Documentation changes are outside this fingerprint.

## Implementation evidence

- [Strict native rule contracts](../../packages/contracts/src/bots/slack-rules.ts) and [Chat-backed rule management](../../packages/gateway/src/slack/rule-tools.ts).
- [Original HTTP input provenance](../../packages/gateway/src/chat/owner-http-input.ts), [owner policy storage](../../packages/gateway/src/slack/rules.ts) and [durable matching/coalescing](../../packages/gateway/src/slack/rule-jobs.ts).
- [Platform source attestation](../../packages/platform/src/slack/enrolled-source.ts), [late output fence](../../packages/gateway/src/slack/rule-publication.ts) and [revoked work retirement](../../packages/gateway/src/slack/rule-revocation.ts).
- [Actual native broker tests](../../tests/gateway/slack-rule-broker.test.ts) and [signed ingress / actual Pi integration](../../tests/gateway/slack-owner-rule-integration.test.ts).

## Reproduce the focused acceptance

Use Node 24+, the frozen pnpm lockfile and the repository's normal test prerequisites. Set `MATRIX_TEST_POSTGRES_URL` to a disposable PostgreSQL 16 database. New owner-rule and provenance fixtures require an actual `pg.Pool`/Kysely `PostgresDialect`; the environment variable alone does not convert unrelated PGlite fixtures into PostgreSQL tests.

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run \
  tests/gateway/chat-owner-http-origin.test.ts \
  tests/gateway/slack-rule-contract.test.ts \
  tests/gateway/slack-rule-instruction.test.ts \
  tests/gateway/slack-rule-tools.test.ts \
  tests/gateway/slack-rule-broker.test.ts \
  tests/gateway/slack-rule-publication.test.ts \
  tests/gateway/slack-rule-revocation.test.ts \
  tests/gateway/slack-rules.test.ts \
  tests/gateway/slack-owner-rule-integration.test.ts \
  tests/gateway/slack-summary-canonical-boundaries.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Run the related Slack source/native-read/automatic-summary regressions, canonical eight-target native typecheck and separate gateway/platform/contracts/bot-runtime release TypeScript checks after the final source revision. Record actual suite/compiler outcomes separately from this reproduction recipe.

## Named faults covered

- Internal Slack submissions can have the same user actor as native Chat. Absence of a Slack receipt cannot prove native input, especially before accepted-pointer persistence or after retention cleanup.
- Editing a positively stamped queued input must clear its original authority; no-op edits may preserve unchanged input.
- Old owner-message retries cannot undo later pause/delete or create duplicate active rules. Explicit fresh creation after deletion is a new audited revision.
- Source names must match exactly; `#technology` cannot authorize `#tech`. Mention-only requests, negated language/cadence and trailing corrections cannot widen a paid trigger.
- Imported tool results cannot authorize rule mutation. The owner provides a fresh complete instruction when clarification is required.
- Creating an explicit owner policy fences older legacy work. A paused/deleted owner policy cannot fall back to the environment rule.
- Final inference claim and canonical output must reject stale rules, missing/expired jobs and changed private authority. Existing streamed text cannot bypass final completion checks.
- Retries of the same message/event and bounded per-thread batches do not duplicate logical work. Source/ref truncation reports partial coverage.

## Remaining runtime and release steps

1. Review and push the exact local commit only when a Preview update is authorized; this branch push triggers Preview workflows.
2. Update only the existing isolated PR tag and owner test computer; verify identical full source SHA and immutable artifact provenance. Keep production untouched.
3. In the private Matrix Chat, give an English standing instruction with exact enrolled source, trigger, timing, focus and language. Verify the agent calls the native rule tool and displays the committed receipt.
4. With separately authorized real Slack input, qualify ordinary-message delivery and owner-mention filtering, then pause/resume/delete and late-work cancellation. Keep summaries in Matrix, zero Slack writes and no executable to-dos.
5. Complete exact-head CI/review, applicable surface acceptance and a separate `FinnaAI/matrix-os-site` documentation PR before broader release. Do not merge/deploy under this local implementation authorization.
