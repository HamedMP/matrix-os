# First Gmail collection and existing ordinary copies

ENG-355. Supports the Gmail verification stack; public behavior is documented in FinnaAI/matrix-os-site PR287.

A newly created private chat can persist an assistant delta, tool activity or Pi cache before its first Gmail read. Installed trusted writers now issue an owner/chat/copy/hash receipt in the same PostgreSQL transaction as that ordinary content. On the first Gmail mark, an exact live receipt permits atomic adoption into Google provenance; current consent, provider and source checks remain mandatory and independent.

Receipts contain metadata only. They expire after 30 days, are capped at 10,000 per owner and 200,000 globally, clean at most 100 expired entries per write, and cascade with the server-created birth. Existing copies lacking a receipt, changed payloads, foreign owners, expired proof and unknown history refuse adoption. No legacy copy is retroactively certified. Installed ordinary writers also refuse to overwrite preexisting unproven copies.

Lock order is context, provenance registry, then content. Receipt insertion and retirement share the actual content transaction; rollback leaves neither content nor proof. Proof expiry participates in the actual COMMIT-return release fence. Successful adoption retires the ordinary receipt after registering exact Google lineage.

Validation covers first-mark continuation for canonical assistant messages, activity transitions and Pi cache load/save; missing, expired, foreign or modified proof; uninstalled old content; rollback; owner capacity; bounded cleanup; birth deletion; and expiry during actual COMMIT return. Native PostgreSQL is required. Run and queue context snapshots use the same exact receipt rules, including no-op adoption before processing when startup supplies its owning transaction seam. Startup installation, deployed account/provider evidence and five-surface live validation remain separate gates.
