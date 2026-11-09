# Data Model: Email Invitations for Matrix.page Apps

## Ownership and authority

- `public_sites` remains the publication and access-mode source of truth.
- Invitation, delivery, grant, session, and audit rows belong to the
  publication owner and inherit its region and deletion lifecycle.
- A recipient owns their Clerk identity. A grant stores only the stable Clerk
  user identifier needed to enforce the owner's sharing decision.
- Visitor form/app data remains in the publication owner's Postgres and is not
  moved into Platform invitation tables.
- Clerk and the mail provider are identity/delivery dependencies, never the
  publication authorization database.

All timestamps are `TIMESTAMPTZ`. UUIDs are server-generated. Email text is PII
and must not appear in normal logs, metrics, analytics, URLs, or audit metadata.

## Existing entity change: `public_sites`

| Field | Change |
| --- | --- |
| `access_mode` | Widen check from `public | private_link` to `public | private_link | private_email` |
| `revision` | Existing optimistic-concurrency source; every mode/lifecycle mutation increments it in the targeted write |

The migration must explicitly drop/replace the existing named check constraint;
`ADD COLUMN IF NOT EXISTS` does not update an installed constraint. Existing
rows retain their values.

## `public_site_email_invitations`

One durable owner intent per normalized email and publication. A resend updates
the same row and increments `generation`; it does not create parallel active
recipients.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID PK | Stable inventory identifier; never reused across sites |
| `site_id` | UUID FK → `public_sites(id)` | `ON DELETE CASCADE` |
| `normalized_email` | TEXT | Trimmed then Unicode-independent lowercase; 3–254 characters; valid email; PII |
| `display_email` | TEXT | Last owner-supplied trimmed spelling; same validation; PII |
| `generation` | BIGINT | Starts at 1; increments on resend/re-invite |
| `state` | TEXT | `pending | accepted | expired | revoked` |
| `delivery_state` | TEXT | `queued | sending | sent | failed | ambiguous | suppressed` |
| `invited_by_clerk_user_id` | TEXT | Verified publication owner; bounded Clerk ID |
| `accepted_clerk_user_id` | TEXT nullable | Set exactly once for a generation; stable authority after acceptance |
| `created_at` | TIMESTAMPTZ | First creation |
| `issued_at` | TIMESTAMPTZ | Current generation start |
| `expires_at` | TIMESTAMPTZ | `issued_at + 7 days` for pending generation |
| `accepted_at` | TIMESTAMPTZ nullable | Required only for `accepted` |
| `revoked_at` | TIMESTAMPTZ nullable | Required only for `revoked` |
| `state_reason` | TEXT nullable | Coarse enum such as `owner`, `duplicate_identity`, `mode_changed`, `unpublished`, or `recipient_inactive`; never a provider/raw error |
| `updated_at` | TIMESTAMPTZ | Every state/generation change |
| `revision` | BIGINT | Starts at 0; targeted owner mutations increment |

### Constraints and indexes

- `UNIQUE (site_id, normalized_email)` is the logical singleton.
- `CHECK (expires_at > issued_at)`.
- State/timestamp consistency checks:
  - `pending`: no accepted/revoked identity/time.
  - `accepted`: accepted identity/time required, revoked time absent.
  - `expired`: accepted identity/time and revoked time absent.
  - `revoked`: revoked time required.
- `(site_id, updated_at DESC, id DESC)` supports keyset inventory.
- `(accepted_clerk_user_id)` partial index supports recipient deletion.
- Expiry sweep index on `(expires_at, id)` where `state = 'pending'`.

The email is not globally unique. One person may be invited to several sites.
Provider-specific plus/dot/domain alias normalization is forbidden.

## `public_site_viewer_grants`

Durable site-scoped viewer authority created only by successful acceptance.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID PK | Server-generated |
| `site_id` | UUID FK → `public_sites(id)` | `ON DELETE CASCADE` |
| `invitation_id` | UUID FK → invitation | `ON DELETE CASCADE` |
| `invitation_generation` | BIGINT | Generation accepted; immutable |
| `clerk_user_id` | TEXT | Stable accepted recipient identity |
| `granted_at` | TIMESTAMPTZ | Acceptance transaction time |
| `revoked_at` | TIMESTAMPTZ nullable | Null only while active |
| `revocation_reason` | TEXT nullable | Enum: `owner | mode_changed | unpublished | owner_deleted | recipient_deleted | recipient_inactive | reinvited` |

### Constraints and indexes

- `UNIQUE (invitation_id, invitation_generation)` guarantees one winner.
- Partial `UNIQUE (site_id, clerk_user_id) WHERE revoked_at IS NULL` prevents
  duplicate active authority for one account.
- `(clerk_user_id, revoked_at)` supports recipient lifecycle cleanup.
- An active grant is valid only when:
  - its publication is active and `private_email`;
  - `revoked_at IS NULL`;
  - its invitation is `accepted`, on the same site and generation, and bound to
    the same Clerk user.

Historical revoked grants may remain for export/audit until owner deletion or
retention policy removes them. They never authorize.

## `public_site_viewer_sessions`

Opaque browser sessions. These are not Clerk sessions and never convey owner
or cross-site authority.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID PK | Public row ID in strict cookie envelope |
| `site_id` | UUID FK → `public_sites(id)` | `ON DELETE CASCADE` |
| `grant_id` | UUID FK → viewer grant | `ON DELETE CASCADE` |
| `secret_hash` | CHAR(64) | SHA-256 hex of 32 random bytes; raw secret returned once |
| `created_at` | TIMESTAMPTZ | Exchange time |
| `expires_at` | TIMESTAMPTZ | At most 30 days; reauthentication creates/rotates a session |
| `last_seen_at` | TIMESTAMPTZ | Optional coarse update, never required for authorization |
| `revoked_at` | TIMESTAMPTZ nullable | Set with grant or account revocation |

### Constraints and indexes

- `(site_id, id)` direct lookup.
- `(grant_id, revoked_at)` supports transactional revocation.
- `(expires_at, id)` supports bounded cleanup.
- Raw secrets never enter the database, logs, analytics, export, or owner API.
- Compare decoded fixed-length secret hashes using `timingSafeEqual`.
- A session authorizes only when it, its grant, invitation, and site are active.

One account may have several browser sessions. The implementation caps active
sessions at 20 per grant; creating the 21st revokes the least-recently-created
active session in the same transaction.

## `public_site_invitation_deliveries`

Durable outbox for external email delivery. It is operational state, not access
authority.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID PK | Delivery job ID |
| `invitation_id` | UUID FK → invitation | `ON DELETE CASCADE` |
| `invitation_generation` | BIGINT | Only the current generation may send |
| `idempotency_key` | UUID | Unique stable provider request key when supported |
| `state` | TEXT | `queued | leased | sent | failed | ambiguous | cancelled` |
| `attempts` | SMALLINT | 0–5 |
| `available_at` | TIMESTAMPTZ | Retry eligibility |
| `lease_token` | UUID nullable | Worker ownership |
| `lease_until` | TIMESTAMPTZ nullable | Five-minute crash-recovery lease |
| `provider_message_id` | TEXT nullable | Bounded opaque provider reference; never exposed to clients |
| `failure_code` | TEXT nullable | Coarse enum only: `configuration | throttled | rejected | timeout | unavailable | unknown` |
| `sent_at` | TIMESTAMPTZ nullable | Provider accepted delivery |
| `created_at` | TIMESTAMPTZ | Enqueue time |
| `updated_at` | TIMESTAMPTZ | Last transition |

### Constraints and indexes

- `UNIQUE (invitation_id, invitation_generation)` permits one active delivery
  job per generation.
- Claim index on `(state, available_at, created_at)`.
- Lease claim: transaction selects at most 25 eligible rows `FOR UPDATE SKIP
  LOCKED`, sets token/deadline, commits, then calls the provider.
- Completion update requires matching `id + lease_token + generation`.
- Stale-generation jobs become `cancelled`, never sent.
- At most five attempts; exponential retry starts at one minute and caps at one
  hour. Provider `Retry-After` may extend but not shorten the safe delay.
- Sent/cancelled jobs containing PII-linked operational state are removed after
  30 days; current invitation lifecycle remains elsewhere.

## `public_site_access_audit_events`

Append-only owner-visible security history. It is distinct from best-effort
product telemetry.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID PK | Cursor tie-breaker |
| `site_id` | UUID FK → `public_sites(id)` | `ON DELETE CASCADE` |
| `invitation_id` | UUID nullable | Same-site invitation reference; cascade/set-null per reviewed migration |
| `event_type` | TEXT | `invitation_created | invitation_resent | invitation_accepted | invitation_revoked | delivery_sent | delivery_failed | grant_revoked | mode_changed | unpublished` |
| `actor_kind` | TEXT | `owner | viewer | system` |
| `actor_reference` | TEXT nullable | Bounded Clerk ID for owner/viewer or null for system; omitted from analytics |
| `details` | JSONB | Strict bounded schema: generation, coarse reason/from/to modes only; no email, token, URL, provider payload/error |
| `occurred_at` | TIMESTAMPTZ | Transaction time |

Index `(site_id, occurred_at DESC, id DESC)` supports pages of at most 100.
Audit writes share the mutation transaction; telemetry remains best-effort after
commit.

## Capability advertisement

The existing site management response gains a bounded capability object:

```ts
{
  privateEmailInvitations: boolean
}
```

It is true only when:

1. generation-3 migration completed;
2. Clerk inline auth spike/configuration is enabled;
3. mail adapter and sender configuration are healthy;
4. lifecycle webhook secret is configured;
5. Matrix.page edge revision supports the email exchange.

The client never infers readiness from access-mode enum support alone.

## State transitions

### Invitation

```text
create/re-invite
    └─> pending + queued delivery (generation N)
            ├─ provider accepted ─> pending + sent
            ├─ provider failure  ─> pending + failed/ambiguous (retryable)
            ├─ seven days pass  ─> expired
            ├─ owner revoke     ─> revoked
            └─ verified accept  ─> accepted + active grant

expired/revoked --explicit owner resend/re-invite--> pending (generation N+1)
accepted -------owner revoke/mode change-----------> revoked + grant/session revoke
```

Resend is allowed for pending delivery failure or expired invitations. It
increments generation and cancels old delivery work. Re-inviting a revoked
recipient is explicit and also increments the
generation. An accepted active recipient is not silently resent.

### Viewer exchange

```text
Clerk bearer
  ├─ active grant for (site, user) ─> rotate/create viewer session
  └─ no active grant
       ├─ one or more current invitations matching verified emails
       │    └─ atomic invitation accept + grant + session + audit
       └─ otherwise ─> coarse denial
```

If several addresses on the same Clerk account are independently invited to the
same site, the transaction accepts the oldest `(issued_at, id)` match and
revokes the other matching pending rows as `duplicate_identity`; one account
therefore cannot regain a revoked grant through a second pending alias. The app
URL is only a destination, not an invitation credential. The response
never distinguishes nonexistent, expired, mismatched, accepted-by-
another-user, revoked, or cross-site invitations.

### Publication mode

```text
public/private_link -> private_email
  revoke/delete credential family for the old private mode
  start with no email grants unless owner creates invitations

private_email -> public/private_link
  in one owner-locked transaction:
    set new mode + revision
    revoke invitation/grant/session authority
    cancel queued/leased delivery intent
    write audit event

private_email -> private_email update/rollback/path rename
  preserve invitation/grant/session authority for the permanent site ID

unpublish/owner deletion
  revoke sessions first, cancel delivery, remove/grant-inactivate rows,
  then remove publication assets/registry under existing lifecycle locks
```

## Concurrency and lock order

### Owner mutation

1. Account-deletion/owner admission.
2. Existing owner advisory lock.
3. `public_sites` row `FOR UPDATE`.
4. Target invitation rows in `(normalized_email, id)` order.
5. Grant/session/delivery rows.
6. Audit insert.
7. Targeted site/invitation revision update and commit.

### Recipient acceptance

1. Verify Clerk token outside a DB transaction.
2. Fetch/validate Clerk user outside a DB transaction.
3. Enter recipient account-deletion admission.
4. Lock `public_sites`, then invitation.
5. Targeted invitation update enforces site, mode, generation, state, expiry,
   verified normalized email, and unbound identity.
6. `INSERT ... ON CONFLICT` grant/session as defined above.
7. Audit insert and commit.

No external call occurs while any database lock is held. A mode change or
revocation that wins before step 5 makes acceptance fail closed.

## Retention, export, and erasure

- Owner export includes bounded pages of invitation lifecycle, grant state,
  delivery status, and audit events. It excludes raw/hashes, cookies, provider
  payloads/errors, and unrelated recipient profile data.
- Owner deletion cancels delivery and removes owner-scoped invitation PII with
  the publication.
- Recipient deletion or inactive lifecycle event revokes grants/sessions by
  Clerk user ID. It must not delete the owner's invitation record silently;
  accepted identity is cleared or pseudonymized according to the deletion
  service's reviewed policy while retaining a coarse revoked audit event.
- Delivery operational rows expire after 30 days. Audit retention follows the
  publication lifecycle and owner erasure.
- Soft-deleted/revoked rows are excluded from normal authorization reads.
