# Qualified financial refusal boundaries

ENG-355 extends the qualified-funded runtime's existing transaction and usage invariants. No processing profile, provider, consent or rollout is approved here.

A nested funded authorizer can persist a waiting interactive priority claim before throwing its typed rate-limit refusal. The qualified service must carry only that typed priority outcome through its outer transaction, repeat current route/admission checks, commit the claim, then report refusal. Database, cancellation and other policy failures still abort and roll back. This preserves owner-wide priority across later background requests without granting work or reserving credit for the waiting request. Qualified service diagnostics use fixed classes rather than provider-controlled exception names.

Real PostgreSQL regression: an active reservation blocks a second interactive request; its claim remains after rejection, prevents background admission after the first reservation is released, and is consumed atomically with the original interactive retry. Existing persistence failure/revocation/expiry tests retain their rollback expectations. No actual provider call or deployment is involved. Public documentation remains the existing ENG-355 site deliverable; the financial transaction detail does not change product permission copy.
