# Bot schema compatibility after a reviewed runtime change

Tracking: ENG-139. This repairs Bot service startup; it adds no execution route.

## Trigger and behavior

The deployed provider-authorization build at `dfb4528ade345206d688710ca8432ce500443036`
records migration 5, `bot_provider_connections`. Returning to a main build whose
registry stops at version 4 makes `bootstrapBotDatabase` reject that schema.
`startBots` then supplies no Bot dependencies and existing Bot reads return 503.

Main must include the exact deployed additive migration, preserving its version,
name, SQL, existing rows and constraints. It creates empty tables on a clean
database and skips them on an already migrated database. Existing definitions,
history, bindings and provider authorization rows stay unchanged. Legacy Agent
definitions without a recipe binding retain their existing execution behavior;
this change does not convert them or inherit permissions.

## Migration invariants

- Each version keeps its existing transaction and schema advisory lock.
- Under that same lock, validate recorded version/name pairs before pending DDL.
- Reject unknown future versions and colliding names without applying missing
  current migrations. Never delete a migration row to make an older build boot.
- Reserve deployed v5 for `bot_provider_connections` and deployed v6 for
  `bot_chatgpt_plan_devices`; independently developed migrations must use a
  later unallocated version after integration.
- Main exposes no native-provider executor or authorization API from #2198.
  Retained provider tables are dormant metadata until that feature is reviewed.

## Auth and surface contract

| Route | Authority | Effect |
| --- | --- | --- |
| GET `/api/chat-agents/:agentId/direct-chat` | Existing authenticated personal owner | Resolve only the owner's live recipe binding |
| GET `/api/chats/:chatId/bot` | Existing authenticated personal owner | Read owner-bound Bot identity |
| GET `/api/chat-agents/bot-recipes` | Existing authenticated principal | Read the unchanged recipe catalog |

Web Canvas and Web Desktop share ChatApp and the Bot client; Electron Desktop
uses the same Bot contracts in its WorkTab. Unknown or failed identity remains
fail-closed on every surface. No mobile, client routing or presentation behavior
is changed here.

## Verification and Human Review

Replay the frozen deployed v5 SQL through real startup and HTTP route wiring.
Verify 200 with the original bound Chat, retained definition/revision and
authorization metadata, clean migration/restart, version/name conflicts and
unknown-future refusal before writes. The frozen fixture remains independent of
the current registry so reverting the fix reproduces the 503.

Use a per-PR Preview and the exact-source production Electron build. Open an
existing recipe Bot twice and verify the same history and Bot identity; open
an ordinary Chat and verify its ordinary controls. A legacy definition lacking
a binding remains a separate migration/product decision. No owner Main update,
funding change, provider grant, Greptile request or merge is part of this review.

## Released v6 device-pin compatibility

Tracking: [ENG-145](https://linear.app/matrix-os/issue/ENG-145), a focused child of ENG-139.

The provider build `30bba5fd3dbb831bfa733f27347e863bce20624f` records v6,
`bot_chatgpt_plan_devices`, unconditionally during Bot bootstrap. A registry
ending at v5 correctly refuses that schema, so a healthy general gateway does
not establish that Bot services started. Append the exact released additive v6
DDL and dormant table type. Keep the existing strict version/name validation
inside the schema advisory transaction lock; do not import the provider
branch's weaker validator or remove migration records.

The v6 table stores owner/computer device ID and public-key security pins.
They are durable first-device trust identities, not disposable cache. Preserve
all rows exactly, including pins for other computers and owners. Bootstrap must
never rebind, clear or replace them. On a clean owner, v6 creates an empty table;
on a deployed v6 owner it applies nothing. No provider authorization, grant,
key-reader, peer service, execution route or settings fallback is added here.

Frozen source provenance: released migration file SHA256
`f94dfc67dafb64f40a6d0c82d34010299e49826990d0d1c9c4fd21f9a6dd4c69`;
exact 366-byte SQL SHA256
`511b94401e667289f625610965219b02f1df4d1bc6c4c29edc7e7c24ea2b1122`.
The independent fixture does not call the production v6 migration. Regression
coverage replays frozen v5/v6, seeds multiple owner/computer pins and existing
authorizations/execution bindings/grants, then verifies Bot startup and bound
identity without changing definitions or historical messages. Fresh/repeated
startup validates device constraints; pooled Postgres proves concurrent v5-to-v6
application once and unchanged pins on deployed v6 restart. Wrong v6 names and
unknown v7 records reject before pending current-version DDL.

This fixes only the schema startup barrier. It does not establish backward
compatibility for canonical Anthropic keys/logout tombstones, native provider
settings and workflows, Claude task authorization, ChatGPT Plan execution or
retained selected routes. Those require separate reviewed preservation and live
acceptance before a runtime replacement. Schema compatibility alone cannot
justify a deployment or model/funding fallback.

Documentation deliverable: update the public developer/support documentation in
a separate `FinnaAI/matrix-os-site` PR with dormant v6 preservation and this
schema-only boundary; retain private operational snapshots outside public docs.
