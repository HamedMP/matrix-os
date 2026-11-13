# Convert an existing app without losing its records

1. Identify the exact app path, slug, registration, manifest, schema and persistence
   implementation. Read its existing DESIGN.md and actual UI before editing. Record
   baseline row count and sample record IDs without exposing private content.
2. Back up source/manifest and export owner data through an authorized existing
   export path. Keep backups outside served build assets and clean temporary copies
   after the owner confirms recovery. Do not claim a source snapshot backs up Postgres.
3. Keep the app slug, registration, table names, column meanings and owner database.
   Replace reads/writes with the collaboration bridge in the building reference.
   Add change subscriptions and retained-input/error behavior. Preserve visual design.
   No second schema, recipient copy, replacement registration, or reset/seed step.
4. Add compatibility fields, calculate the exact schema digest, rebuild, and check
   readiness. Compare owner records/IDs before and after; then save and reopen.
5. Ask for the organization and guide sharing. Explain that all existing records in
   the app become visible to that organization's current members before confirmation.

## Browser-only data

The skill does not automatically migrate or erase browser storage. Ask which
browser/profile/device contains it. Use authorized access there to export a
recoverable source snapshot; localStorage in a different profile or the Matrix
sandbox cannot prove the original data is empty. If access is unavailable, stop
the migration and give export instructions while preparing the source changes.

Prepare a dry-run mapping: source count/IDs, target tables/fields, validation failures,
and collisions with existing owner rows. Present it before importing. Preserve IDs
where valid; use deterministic mappings/receipts for repeated imports so retries
cannot duplicate records. Reuse an existing bounded transactional import boundary;
if none supports this data shape, report the migration blocker rather than invent
a bridge API or issue sequential writes while calling them a transaction.

Verify imported counts and representative fields, then reopen through the owner's
app. Retain the source snapshot. Delete original browser data only after explicit
customer approval for that exact deletion; conversion approval alone is insufficient.

## Unsupported dependencies

An arbitrary custom server, incompatible runtime, undeclared table, direct credential,
or required owner integration/AI authority may block collaboration. Name the affected
feature and its supported alternative. Do not silently drop functionality or move
the app/data to another host to get a readiness label.
