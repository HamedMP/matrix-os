# Synthetic invoice workflow

All records and original PDFs are synthetic and **not payable**. No real service/account is accessed, no credentials are requested, and this fixture cannot send, pay or change external data.

The lab supervisor serves only these fixed owner-local paths:

- `http://127.0.0.1:8730/invoices`: page 1 of 2, original displayed totals EUR 144.00 and EUR 90.00.
- `/invoices/page-2`: page 2 of 2, repeats both document IDs; the second displayed amount is USD 95.00 while its original PDF remains EUR 90.00.
- `/invoices/documents/SYN_INV_001.pdf` and `/invoices/documents/SYN_INV_002.pdf`: deterministic original PDF attachments, not prints of a web page.

Expected coverage: **2 pages, 4 displayed records, 2 unique original documents**. Preserve the conflicting displayed metadata for `SYN_INV_002`; do not silently convert currency, overwrite evidence, infer a payable amount, or treat a duplicate as a new invoice. Hash-identical originals should produce one unique document in the review packet.

| Document ID | Original | Bytes | SHA-256 |
| --- | --- | --- | --- |
| SYN_INV_001 | EUR 144.00 | 998 | ec56e5c82123878be5433574f2213df71970a842b169ef7bd899e070d52c9564 |
| SYN_INV_002 | EUR 90.00 | 997 | ec4a48553766e82ee906d9dcc94256a06da5af17aeffcfe81822e09d41b53271 |

`fixture.mjs` exports `INVOICE_FIXTURE_EXPECTED` with hashes, coverage and contradictory metadata for developer verification. That answer key is not an HTTP endpoint. The originals contain full PDF object tables and byte-accurate xrefs; both were independently parsed by Poppler as one-page PDF 1.4 documents, with no encryption, forms or JavaScript.

For the optional human handoff test, start the scoped lab supervisor with `BROWSER_LAB_INVOICE_HANDOFF=true`. The visible credential-free checkpoint says **Continue synthetic owner handoff**. The owner uses Matrix **Take over**, clicks Continue, and then **Resume**; the agent must take a fresh snapshot before proceeding. This models takeover only and does not prove authentication, passkeys or password-manager behavior. Readiness expires after 15 minutes and disappears on supervisor restart.

The fixed `/invoices/owner-login` POST accepts only `{epoch, acknowledge:"synthetic-only"}`. `/invoices/reset` accepts only `{epoch}` and increments the synthetic epoch. Both reject stale epochs, unknown fields, non-JSON and bodies exceeding 2 KiB. There is one bounded ephemeral state and no identity/session database. These are fixture controls, not owner-authentication APIs; browser automation has no arbitrary fetch/evaluate action.

Focused tests cover pagination/conflicts, PDF bytes/xrefs/hashes, handoff/reset guards and actual lab-server composition. Invoice collection passes only after a real native harness obtains both originals through observed links, reports complete two-page coverage, preserves the conflict and leaves review/payment decisions to the owner.
