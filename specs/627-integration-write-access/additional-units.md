# Execution additions and qualification

The original plan remains unchanged. The owner requested all missing read/write
support; follow-on units address the remaining managed catalogs.

- U6: Stripe customer profiles, QuickBooks customers and Xero contacts use the
  shared bounded transport. Bind the selected account, check company/tenant
  membership, require QuickBooks SyncToken, and never create payments or ledger
  entries. Existing key scopes are authoritative and never expanded.
- U7: Managed MCP PostHog insight metadata, Loops contact properties and lemlist
  empty draft campaigns require explicit fresh reconnect consent. Persist opt-in
  and returned scopes encrypted; enforce again after refresh before dispatch.
  Only explicit reconnect may update the compiled preset endpoint.
- U8: Bokio write availability requires current token scope proof after explicit
  consent. Legacy grants and providers omitting proof stay read-only. Draft-only
  invoice actions must never finalize or issue an invoice.

No new public endpoints or auth headers are introduced. Current owner identity,
revision/CAS fences, schema validation and existing write approval remain the
source of truth. Missing permissions must fail without a fallback credential.

Local regression tests prove mappings and policy, not live account permissions.
Figma rejects registration of Matrix's client; do not mark live sign-in or design
writes verified. Existing default REST scopes omit file-content read. Granola's
current managed upstream is read-only. Public docs must distinguish supported
operations, current grants and external approval requirements.
