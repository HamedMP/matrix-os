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
- Reserve deployed v5 for `bot_provider_connections`; independently developed
  migrations must use a later unallocated version after integration.
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
