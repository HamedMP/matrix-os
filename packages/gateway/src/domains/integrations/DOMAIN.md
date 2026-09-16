# DOMAIN: `integrations` — funded-AI and kernel credential cooperation

Owns gateway-side credential/provisioning cooperation with providers:
funded-AI credential management and kernel settings/credentials access.
May import `identity`, `_shared`. (The larger `integrations/` folder at
`src/` root — Pipedream/custom-MCP/bridge routes — joins this domain in a
follow-up.)

## Contents

`funded-ai-credential-manager.ts` ·
`funded-ai-funding-summary-client.ts` · `kernel-credentials.ts` ·
`kernel-settings.ts` · `ws-message-schema.ts` (WS wire schemas over the
kernel credential/model contracts — moved here so `_shared` keeps its
no-domain-imports rule)

## Decision log

- 2026-09-16 (Phase 1-A3/W3): flat credential files moved first; folder
  consolidation with `src/integrations/` deferred (its routes have wider
  importer fan-in).
