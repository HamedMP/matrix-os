# SDK verification — managed integration expansion

Date: 2026-08-29

## Gate status

The live Pipedream development-environment spike is **blocked** in this checkout. `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID`, a development external-user ID, and connected provider test accounts are not present. No successful provider read, granted-scope capture, or SDK component key is claimed here.

Run `node --import tsx scripts/verify-pipedream-integration-expansion.ts` with `PIPEDREAM_ENVIRONMENT=development` and the documented `PIPEDREAM_VERIFICATION_CASES` input. Paste its JSONL output and the Pipedream connection metadata below before release. The script rejects production projects and invokes one real read through Matrix's action boundary for each provider.

| Provider | Documented app slug/auth evidence | Paid-plan evidence | Live app/auth/scopes/read | Component keys |
| --- | --- | --- | --- | --- |
| Google Docs | `google_docs`; Pipedream's current app page exposes this slug | Not listed as Premium App | **BLOCKED** | None recorded |
| Notion | `notion`; current Pipedream app catalog | Not listed as Premium App | **BLOCKED** | None recorded |
| Figma | `figma`; Pipedream example shows OAuth access token and `/v1/me` read | Not listed as Premium App | **BLOCKED** | None recorded |
| PostHog | `posthog`; Pipedream example shows API-key auth and `/api/users/@me/` read | Not listed as Premium App | **BLOCKED** | None recorded |
| Jira | `jira`; Pipedream example shows OAuth and `https://api.atlassian.com/me` | Jira is listed as a Premium App | **BLOCKED** | None recorded |
| Stripe | `stripe`; Pipedream example shows API-key auth | Stripe is listed as a Premium App | **BLOCKED** | None recorded |

Sources consulted: Pipedream's official app catalog, app-discovery/API documentation, and Premium Apps list. Documentation confirms candidate slugs and auth shapes, but it does not replace the required connected-account spike.

## Release rule

- Do not hand-author or infer component keys. `discoverComponentKeys()` only accepts keys returned by the live SDK action catalog.
- PostHog and Jira actions have no speculative component keys or direct endpoint contracts. They deliberately fail as not implemented until the live spike records compatible SDK components.
- The remaining new providers use explicitly reviewed direct API routes, but their end-to-end release gate is still a successful development-account read.
- Stripe must use a connected restricted read-only key (`rk_...`) scoped only to the catalog reads. Matrix billing Stripe credentials are never accepted by this flow.

## Granola verification

Granola's current official documentation confirms the public endpoint `https://mcp.granola.ai/mcp`, Streamable HTTP, browser OAuth with bearer tokens, and no MCP API-key/service-account mode. The upstream tools currently documented are `list_meetings`, `get_meetings`, and paid-plan-only `get_meeting_transcript`; Matrix maps these to stable `list_notes` and `get_note` actions after runtime schema discovery.

The live Granola OAuth/read spike is also account-gated and remains **BLOCKED** in this checkout.
