# Integration reads, approved writes and MCP sign-in

Track under [ENG-91](https://linear.app/matrix-os/issue/ENG-91/validate-launch-integrations-end-to-end).
The owner authorized repairing Figma sign-in and missing integration writes.
Recommend review by the integration and product owners; release qualification
remains a gate. Execution units are in [plan.md](plan.md) and
[additional-units.md](additional-units.md).

## Intended behavior

1. An owner can connect an OAuth MCP server advertising public, client-secret
   basic or client-secret post authentication. Client secrets and their expiry
   remain in the encrypted owner/server grant. Reconnect registers a replacement
   when a secret expires; zero expiry means non-expiring. PKCE, issuer binding,
   one-use state, credential CAS and refresh/removal leases remain authoritative.
2. Registration denial returns a generic setup-required response. Non-success
   response bodies cannot turn a denial into a JSON parsing failure or leak
   upstream details. Figma still requires approval of Matrix as an MCP client;
   do not impersonate another client or claim design access without authorization.
3. Connected services expose reviewed, bounded write actions alongside reads.
   Existing grants are never expanded by a catalog update. Account permissions,
   explicit write approval and current runtime support determine execution.
4. Managed MCP writes require fresh reconnect opt-in, matching granted scopes,
   enabled compatible remote tools and strict action planning. Check the grant
   again after refresh immediately before dispatch. Proven read scopes remain
   visible independently of write opt-in. Only explicit reconnect can migrate a
   compiled preset endpoint, atomically disabling its old authority first.
5. Finance actions modify customer/contact profiles only. QuickBooks requires
   the current SyncToken and exact company preflight; Xero checks tenant
   membership and binds its tenant header. Stripe uses exact form encoding.
   These actions cannot charge, move money, change subscriptions or post ledgers.
6. Bokio customer/draft actions require actual token scope proof from fresh
   consent. Missing scope proof keeps writes hidden; refresh cannot widen the
   prior grant. Create and append share a bounded line-value schema; creation
   also bounds the aggregate. Append does not claim to validate the unknown
   existing invoice total. Never finalize or issue an invoice.
7. Agents can discover complete nested parameter examples and limits for
   structured actions. Existing Google slide IDs may be shorter than IDs chosen
   when creating a slide. Granola remains read-only while its upstream is.

## Affected surfaces and journey

Web Canvas, Web Desktop and Electron Desktop consume the shared integration
catalog, account state and action contracts; Web Mobile and Native Mobile use
those same contracts wherever Connect Apps/chat tools are available. No renderer
owns separate capability or permission logic. Owners connect/reconnect, review
provider consent, approve tool selection and then request an allowed action.
Missing grants, tools or setup remain unavailable. Runtime evidence for each
supported surface is required before release; local API tests are not visual
qualification. No renderer layout or navigation changes are introduced.

## Existing authorization matrix

No new routes or credentials are introduced. Existing boundary validation,
mutation body limits, delegation and actor/account selection remain in force.

| Route family | Authorization | Public |
| --- | --- | --- |
| `/api/integrations` catalog/accounts | Authenticated owner or existing delegated read capability | No |
| `/api/integrations/call` | Owner or existing scoped actor; selected account, action risk and approval policy | No |
| `/api/mcp-servers` CRUD/connect/discover/test | Existing authenticated owner; owner/revision fences | No |
| `/api/mcp-servers/:id/call` | Existing owner/scoped policy and one-use tool approval; managed presets reject raw calls | No |
| `/api/mcp-servers/oauth/callback` | Expiring, encrypted, one-use owner/server-bound OAuth state and PKCE | Yes, state-protected |

## Wiring and resource limits

Shared contracts and reviewed action maps feed one registry. Gateway validation
and approval precede the selected-account executor. Pipedream actions use fixed
API origins and strict identifiers; managed OAuth actions pass through the
platform planner and encrypted-grant broker. MCP metadata/token requests retain
pinned DNS validation and reject redirects. New bounded Pipedream transport caps
request bodies at 64 KiB, responses at 1 MiB/4096 chunks, and credential/network/body
work at 10 seconds. Drive uploads are limited to 8 KiB UTF-8 text. No arbitrary URL,
header, payload or retrying-mutation tool is added. Durable multi-step changes
keep existing transactions/CAS; remote calls remain outside transactions.

## Acceptance checks

- Public/basic/post sign-in, refresh and revocation retain encrypted secrets;
  invalid registration methods, credentials and expiry are rejected safely.
- Secret expiry is retained and reconnect replaces expired clients, including
  the exact expiry boundary; live/non-expiring clients remain reusable.
- Plain-text 403 becomes a safe setup-required error; no raw body or secret is
  exposed to clients, URLs, projections or normal logs.
- Action schemas reject unsafe paths/payloads before credential lookup; writes
  cannot pass through a read capability or fallback to another credential.
- Combined route/executor/registry tests cover Drive upload, Jira resource and
  finance tenant binding, strict write bodies and bounded response/deadline IO.
- Managed planner-to-broker tests deny legacy/pending/insufficient grants and
  recheck narrowed refresh scopes before remote writes; PostgreSQL tests verify
  persisted owner/revision-fenced preset endpoint migration.
- Agent-visible PostHog query examples validate against the actual nested schema;
  existing slide `p` works while new slide IDs retain creation rules.
- Bokio create/append reject oversized line values before authorization, accept
  the boundary and keep undocumented/unknown scope grants read-only.
- Typecheck, pattern checks and applicable regression/coverage gates pass.
  Current-head Greptile 5/5, runtime evidence and provider consent precede release.
- Separate public documentation PR updates capabilities and limitations:
  [matrix-os-site #265](https://github.com/FinnaAI/matrix-os-site/pull/265).

## Risks and qualification

Catalog support does not prove an account's live write permissions. Figma may
refuse Matrix client registration and its default REST grant may omit file
content access. Bokio may omit scope proof. Existing provider plans, admin policy,
restricted keys and account roles may require owner action. Failed sign-in must
retain a disabled/auth-required connection without tool authority; revocation
failures retain encrypted evidence for retry. No live design, email/message,
payment or invoice mutation is part of automated validation. New code remains
unreleased until review and surface/runtime evidence are complete.
