# Proposed next phase — disabled, requires specific approval

This is the exact proposed data/destination contract for review. No code, environment flags, Reddit switches or tags in this PR activate it.

## Consented PageVisit mirror

Destination: Reddit Ads Conversions API, `https://ads-api.reddit.com/api/v3/pixels/{configured_pixel_id}/conversion_events`, server credentials only. The browser continues using the same configured Pixel. Send `action_source=WEBSITE`, `type.tracking_type=PAGE_VISIT`, real event time and an allowlisted marketing-page URL. Exclude authenticated workspace content, URL fragments, emails and unrelated query values.

| Field | Proposed source and boundary |
| --- | --- |
| `click_id` | Exact valid `rdt_cid` on a real ad landing, carried only after marketing acceptance. Omit for organic traffic. |
| `user.ip_address` | Original connecting browser's public IP, resolved only from a verified ingress path that strips client-supplied forwarded headers and supplies its own trusted identity. Validate IPv4/IPv6 and drop private/reserved addresses. Do not use Reddit's received server IP, the Stripe webhook IP, a fake address or arbitrary `X-Forwarded-For`. |
| `user.user_agent` | Original page request's bounded browser User-Agent from that same ingress. Never substitute the worker or webhook library UA. |
| `user.uuid` | The existing Pixel-created first-party UUID, read through the verified current Pixel cookie contract and carried unchanged. Verify cookie naming/format against the deployed Pixel before implementation; do not generate a second identity when absent. |
| `metadata.conversion_id` | One random per-pageview ID created after acceptance, reused verbatim by Pixel and CAPI for that same event. Persist it only for bounded retries; do not reuse across later pageviews. |

Proposed first-party relay: same-origin POST endpoint, explicit origin checks, small body/schema limit, public anonymous auth model with rate limits and dedupe bounds, trusted ingress-derived client fields, current explicit marketing acceptance, no arbitrary source URLs, and a 10-second Reddit timeout. A client-posted `consent=true` is not an authentication or anti-abuse mechanism. Honor revocation before send and retry; anonymous events expire quickly (proposed maximum five minutes). Keep operational failure logs free of identifier payloads. A bounded retry queue needs TTL and deletion, not an unbounded in-memory map.

## Authenticated conversion enrichment

Additional proposal: `user.email` only for authenticated conversion events with a separately approved advertising-matching purpose and currently valid owner consent. Source it from the owner's verified account record, never browser form scraping or unverified submitted values. Apply Reddit's current documented normalization (lowercase; remove dots and the plus suffix from the local part), then SHA-256 to 64 lowercase hex digits server-side. It remains personal/pseudonymous data. Do not add email to anonymous PageVisit, page URLs, PostHog custom properties, Stripe metadata, client bundles or application logs. No phone field.

Before enabling offline enrichment, implement a server-authoritative owner consent ledger, purpose/version/expiry and withdrawal propagation. Recheck before every send/retry; purge queued enrichment and prevent subsequent invoice enrichment on withdrawal. Store client context only for its approved event/retention window, not across unrelated renewal invoices. Decide the deletion workflow before activation.

## Acceptance before activation

Review the data table and destination with Hamed and the affected engineering/privacy owner. Then implement behind default-off flags and verify a separate Reddit test flow: genuine ad click keeps the exact ID, Pixel+CAPI copies share the conversion ID, duplicate receipt is reported, IP/UA originate from the original browser, unknown/rejected/expired/revoked states send nothing, retries do not double count and private page/query values never leave. Test IDs must stay out of campaign performance reports. Approval to activate applies to this exact signal set and scope; it does not authorize more spending, audience expansion or extra signals.

Success means improved matched, deduplicated event coverage and trustworthy cost per activated/paying user. No score or performance increase is promised; the conversion-integrity PR alone does not lift anonymous PageVisit's score.

Sources: [Reddit CAPI](https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration), [event fields](https://ads-api.reddit.com/docs/v3/operations/Post%20Conversion%20Events), [click ID](https://ads-api.reddit.com/docs/v3/guides/programs/capi/click-id-persistence).
