# Launch Email Templates And Loops Flow Plan

**Status**: Planning/template scope only. No code, provider setup, or live sends are included in this artifact.
**Provider**: Loops only. Do not introduce a second product-email provider.
**Audience**: Engineers and technical founders using Matrix OS for cloud coding, CLI/TUI activation, and company operating work.
**Validated**: 2026-05-30 with Loops CLI 0.6.0 against the Matrix OS team. `loops api-key --output json` succeeded, `loops transactional list --per-page 10 --output json` returned no published transactional emails, and no customer emails were sent.

## Operating Rules

- Clerk and Stripe remain the source systems for auth and billing state. Loops owns product messaging that follows those events.
- Clerk should keep owning auth mechanics such as one-time codes, magic links, and Clerk-managed verification pages unless Matrix explicitly decides to replace that copy.
- Stripe or Clerk Billing should keep owning legal invoices, tax receipts, and payment collection. Loops should send product-facing receipt handoff and activation guidance, not substitute for the billing receipt of record.
- Matrix app/backend events should emit Loops lifecycle events for activation nudges after the source-of-truth app state is committed.
- Email delivery must not block account creation, sign-in, checkout completion, subscription updates, or workspace provisioning.
- Never put provider secrets, webhook signing secrets, API keys, raw provider error payloads, or full customer billing details in docs, Linear, client responses, or email variables.

## Current Loops Inventory

Read-only CLI validation found:

- Active team: `Matrix OS`.
- Published transactional emails: none.
- Mailing lists: `early access`, `users`. Implementations should resolve list IDs by name at setup time instead of hardcoding environment-specific IDs in application code.
- Existing custom contact properties: `matrixLeadScore`, `matrixSourceProjects`, `matrixSourceKinds`, `matrixPriority`.

Required product-email contact properties that do not exist yet:

| Property | Type | Set by | Purpose |
|----------|------|--------|---------|
| `matrixHandle` | string | Clerk/platform provisioning | Human-readable Matrix handle for support and workspace links. |
| `matrixPlan` | string | Stripe/billing flow | Plan or beta cohort label, for example `early_adopter`. |
| `matrixBillingState` | string | Stripe/billing flow | Coarse billing state such as `trialing`, `active`, `past_due`, `canceled`. |
| `matrixSubscriptionStatus` | string | Stripe/billing flow | Raw subscription status bucket mapped to safe product language. |
| `matrixTrialEndsAt` | date | Stripe/billing flow | Trial end date for activation and renewal reminders. |
| `matrixPrimaryGoal` | string | Matrix onboarding | User-selected first goal such as `cloud_coding`, `company_brain`, or `assistant`. |
| `matrixActivationStage` | string | Matrix onboarding/backend | Coarse stage such as `account_created`, `workspace_ready`, `cli_connected`, `cloud_coding_ready`. |
| `matrixCliActivated` | boolean | Matrix CLI/backend | Whether the user completed CLI or TUI activation. |
| `matrixCloudCodingActivated` | boolean | Matrix app/backend | Whether the user completed the first cloud-coding setup path. |
| `matrixRuntimeRegion` | string | Platform provisioning | Coarse runtime region, only when useful for support and not sensitive. |

Default contact identity:

- Loops `userId`: Clerk `user.id`.
- Loops `email`: Clerk primary email address.
- Loops `firstName` / `lastName`: Clerk profile fields when present.
- Loops `userGroup`: `paid_beta`, `early_access`, or `self_hosted` as a coarse segment.
- Loops mailing list: add launch customers to `users`; keep pre-customer leads in `early access`.

## Naming Conventions

Use event names for lifecycle automations and template slugs for transactional email records or Loops automation email names. Keep `_v1` in names so copy can evolve without breaking existing automations.

| Purpose | Loops event name | Loops template / transaction name |
|---------|------------------|-----------------------------------|
| Welcome / account created | `matrix.account.created.v1` | `matrix_account_welcome_v1` |
| Verification or sign-in product prompt | `matrix.auth.product_prompt.v1` | `matrix_auth_product_prompt_v1` |
| Trial or paid beta activation | `matrix.beta.activated.v1` | `matrix_beta_activated_v1` |
| Billing success / receipt handoff | `matrix.billing.succeeded.v1` | `matrix_billing_succeeded_v1` |
| Payment failed / action required | `matrix.billing.payment_failed.v1` | `matrix_billing_payment_failed_v1` |
| Subscription changed | `matrix.billing.subscription_changed.v1` | `matrix_subscription_changed_v1` |
| Subscription canceled | `matrix.billing.subscription_canceled.v1` | `matrix_subscription_canceled_v1` |
| CLI activation nudge | `matrix.activation.cli_nudge.v1` | `matrix_cli_activation_nudge_v1` |
| Cloud-coding activation nudge | `matrix.activation.cloud_coding_nudge.v1` | `matrix_cloud_coding_nudge_v1` |
| Support/admin launch alert | `matrix.admin.launch_alert.v1` | `matrix_admin_launch_alert_v1` |

## Template Inventory

### 1. Welcome / Account Created

- **Source event**: Clerk webhook `user.created`.
- **Loops event/template**: `matrix.account.created.v1` / `matrix_account_welcome_v1`.
- **Subject**: Your Matrix OS account is ready
- **Preview text**: Next step: open your cloud computer and pick the workflow you want Matrix to help with first.
- **CTA**: Open Matrix
- **Required variables**: `firstName`, `workspaceUrl`, `primaryGoal`, `supportEmail`
- **Body copy**:

```text
Hi {firstName},

Your Matrix OS account is ready. Matrix is built for engineers who want one place to run coding agents, terminals, company context, and operating work.

Start by opening your Matrix cloud computer and choosing the workflow that matters first: cloud coding, app building, company brain, or assistant work. Matrix will show which setup steps are required, recommended, and optional.

If something looks blocked, reply here or use {supportEmail}. We can see the launch-readiness state without needing your secrets.
```

### 2. Verification Or Sign-In Product Prompt

- **Source event**: Clerk webhook `user.created` or `user.updated` when the primary email remains unverified after signup, or Matrix app event when a user repeatedly reaches a sign-in wall. Clerk should still own the actual verification code/link unless a later product decision changes that.
- **Loops event/template**: `matrix.auth.product_prompt.v1` / `matrix_auth_product_prompt_v1`.
- **Subject**: Finish sign-in to open Matrix OS
- **Preview text**: Verification keeps your cloud computer tied to the right account before billing or workspace setup continues.
- **CTA**: Continue sign-in
- **Required variables**: `firstName`, `signInUrl`, `supportEmail`, `reason`
- **Body copy**:

```text
Hi {firstName},

Matrix is waiting for a completed sign-in before it can safely open your cloud computer.

Use the same email you used for signup. If Clerk asks you to verify the address, finish that step there, then return to Matrix. We use that identity to route you to the right VPS and keep owner data separate.

If the prompt keeps looping, send us the time you tried and we will check the auth handoff.
```

### 3. Trial Or Paid Beta Activation

- **Source event**: Stripe `checkout.session.completed`, Stripe `customer.subscription.created`, or Clerk Billing equivalent after the paid beta entitlement is active.
- **Loops event/template**: `matrix.beta.activated.v1` / `matrix_beta_activated_v1`.
- **Subject**: Matrix OS paid beta is active
- **Preview text**: Your hosted Matrix computer can now finish provisioning and start the coding setup path.
- **CTA**: Open your cloud computer
- **Required variables**: `firstName`, `workspaceUrl`, `planName`, `trialEndsAt`, `billingPortalUrl`
- **Body copy**:

```text
Hi {firstName},

Your Matrix OS paid beta access is active for {planName}.

Matrix can now finish the hosted-computer path and guide you through the first useful setup: connect a project, open the terminal when needed, and start a cloud-coding run through Symphony.

Your trial currently ends on {trialEndsAt}. Billing details and plan management stay in the billing portal.
```

### 4. Billing Success / Receipt Handoff

- **Source event**: Stripe `invoice.paid` or billing provider success event after an invoice or renewal payment succeeds.
- **Loops event/template**: `matrix.billing.succeeded.v1` / `matrix_billing_succeeded_v1`.
- **Subject**: Matrix OS billing is confirmed
- **Preview text**: Your workspace access is active. Receipts and plan details are available in the billing portal.
- **CTA**: View billing
- **Required variables**: `firstName`, `billingPortalUrl`, `workspaceUrl`, `billingPeriodEnd`, `planName`
- **Body copy**:

```text
Hi {firstName},

Billing for Matrix OS is confirmed for {planName}. Your hosted Matrix workspace remains active through {billingPeriodEnd}.

Use the billing portal for the receipt, payment method, and subscription details. Use Matrix to continue the product work: cloud coding, terminal sessions, company brain, and approved operating workflows.
```

### 5. Payment Failed / Action Required

- **Source event**: Stripe `invoice.payment_failed`.
- **Loops event/template**: `matrix.billing.payment_failed.v1` / `matrix_billing_payment_failed_v1`.
- **Subject**: Action needed: Matrix OS payment failed
- **Preview text**: Update billing to keep hosted workspace access active. Your owner data is not deleted.
- **CTA**: Update payment
- **Required variables**: `firstName`, `billingPortalUrl`, `workspaceUrl`, `retryAfter`, `supportEmail`
- **Body copy**:

```text
Hi {firstName},

The latest Matrix OS payment did not go through. Update your payment method in the billing portal to keep hosted workspace access active.

Matrix does not delete your owner data because of a billing problem. Some paid-only runtime actions may pause until billing is current.

If you already updated the card, give it a few minutes and reopen Matrix. If access still looks wrong, contact {supportEmail}.
```

### 6. Subscription Changed

- **Source event**: Stripe `customer.subscription.updated` or Clerk Billing equivalent when plan, trial, renewal, or status changes without cancellation.
- **Loops event/template**: `matrix.billing.subscription_changed.v1` / `matrix_subscription_changed_v1`.
- **Subject**: Matrix OS subscription updated
- **Preview text**: Your plan state changed. Matrix will keep your workspace and owner data intact.
- **CTA**: Review subscription
- **Required variables**: `firstName`, `billingPortalUrl`, `changeSummary`, `effectiveAt`, `workspaceUrl`
- **Body copy**:

```text
Hi {firstName},

Your Matrix OS subscription was updated: {changeSummary}.

The change takes effect {effectiveAt}. Matrix keeps your workspace state and owner-controlled data intact while access rules update.

Open the billing portal to review plan details, or return to Matrix if you only need to keep working.
```

### 7. Subscription Canceled

- **Source event**: Stripe `customer.subscription.deleted` or a subscription update where the safe billing state maps to canceled.
- **Loops event/template**: `matrix.billing.subscription_canceled.v1` / `matrix_subscription_canceled_v1`.
- **Subject**: Matrix OS subscription canceled
- **Preview text**: Hosted access will end according to your billing state, but your owner data remains preserved.
- **CTA**: Manage subscription
- **Required variables**: `firstName`, `billingPortalUrl`, `accessEndsAt`, `exportDocsUrl`, `supportEmail`
- **Body copy**:

```text
Hi {firstName},

Your Matrix OS subscription is canceled. Hosted paid-beta access is scheduled to end on {accessEndsAt}.

Matrix is designed around owner-controlled data. Your files, configuration, and workspace data should remain preserved according to the product data policy while paid-only runtime access changes.

Use the billing portal to reactivate or review the cancellation. Use {exportDocsUrl} if you want to inspect or export your data before access ends.
```

### 8. CLI Activation Nudge

- **Source event**: Matrix app/backend event when `matrixCliActivated` remains false after account creation or beta activation.
- **Loops event/template**: `matrix.activation.cli_nudge.v1` / `matrix_cli_activation_nudge_v1`.
- **Subject**: Connect the Matrix CLI to your workspace
- **Preview text**: The CLI gives you a fast path into your Matrix cloud computer from the terminal.
- **CTA**: Set up the CLI
- **Required variables**: `firstName`, `cliDocsUrl`, `workspaceUrl`, `matrixHandle`
- **Body copy**:

```text
Hi {firstName},

You can use Matrix from the browser, but the CLI is the fastest path when you are already in a terminal.

Connect the CLI to {matrixHandle} so Matrix can open the right workspace, hand off coding runs, and keep local and cloud context aligned.

This is optional for browsing, but it is the recommended setup for developers using Matrix as their daily coding control plane.
```

### 9. Cloud-Coding Activation Nudge

- **Source event**: Matrix app/backend event when a paid beta user has a ready workspace but has not connected GitHub/project context or started the first cloud-coding run.
- **Loops event/template**: `matrix.activation.cloud_coding_nudge.v1` / `matrix_cloud_coding_nudge_v1`.
- **Subject**: Start your first Matrix cloud-coding run
- **Preview text**: Connect a project, open the terminal context, and let Symphony produce a reviewable handoff.
- **CTA**: Start cloud coding
- **Required variables**: `firstName`, `workspaceUrl`, `githubConnectUrl`, `primaryGoal`
- **Body copy**:

```text
Hi {firstName},

Your Matrix workspace is ready for cloud coding.

Connect GitHub, choose a project, and start with one small task. Matrix will create or reuse the right workspace, show agent progress, keep terminal context nearby, and hand off a branch, validation result, or reviewable next action.

Start with a narrow task. The goal is trust: see Matrix work in the same codebase and workflow you already use.
```

### 10. Support/Admin Launch Alert

- **Source event**: Matrix backend event when a launch-critical onboarding, billing, provisioning, or email-send failure needs operator attention.
- **Loops event/template**: `matrix.admin.launch_alert.v1` / `matrix_admin_launch_alert_v1`.
- **Subject**: Matrix launch alert: {alertType}
- **Preview text**: {safeSummary}
- **CTA**: Open admin console
- **Required variables**: `alertType`, `safeSummary`, `adminConsoleUrl`, `occurredAt`, `severity`, `eventId`
- **Body copy**:

```text
Launch alert: {alertType}

Severity: {severity}
Time: {occurredAt}
Event: {eventId}

{safeSummary}

Open the admin console for the full internal trace. Do not include provider secrets, raw payment payloads, API keys, or customer message bodies in this email.
```

## Event Flow Plan

### Clerk Webhook Flow

| Source | Loops action | Required fields | Idempotency key | Failure behavior |
|--------|--------------|-----------------|-----------------|------------------|
| Clerk `user.created` | Upsert contact, add `users` list, emit `matrix.account.created.v1` | `email`, `userId`, `firstName`, `lastName`, `primaryEmailVerified`, `workspaceUrl` when available | `clerk:{event.id}:welcome_v1` | Persist user/platform state first. Queue Loops work after success. If Loops fails, log sanitized source/event/template/retry count and retry asynchronously. Do not fail account creation. |
| Clerk `user.updated` | Update contact properties; optionally emit `matrix.auth.product_prompt.v1` when primary email remains unverified and product decides Loops owns reminder copy | `email`, `userId`, `primaryEmailVerified`, `reason`, `signInUrl` | `clerk:{event.id}:auth_prompt_v1` | Same non-blocking retry policy. Suppress repeated prompts by checking latest contact/property state and prior idempotency key. |
| Matrix sign-in wall event derived from Clerk state | Emit `matrix.auth.product_prompt.v1` | `email`, `userId`, `reason`, `signInUrl`, `supportEmail` | `matrix:{eventId}:auth_prompt_v1` | Never send codes or magic links through Loops. Send only product context and route back to Clerk sign-in. |

### Stripe / Billing Event Flow

Matrix currently uses Clerk Billing in the shell, while this launch plan must still map Stripe billing events because Loops is connected to Stripe and Stripe remains the billing-event vocabulary. If billing events arrive through Clerk Billing instead of direct Stripe webhooks, map the Clerk Billing event to the matching safe Stripe-style event below before emitting the Loops event.

| Source | Loops action | Required fields | Idempotency key | Failure behavior |
|--------|--------------|-----------------|-----------------|------------------|
| Stripe `checkout.session.completed` | Update contact billing properties; emit `matrix.beta.activated.v1` when entitlement is active | `email`, `userId`, `planName`, `trialEndsAt`, `workspaceUrl`, `billingPortalUrl` | `stripe:{event.id}:beta_active_v1` | Do not block checkout success or provisioning. Log and retry Loops work after entitlement persistence. |
| Stripe `customer.subscription.created` | Update contact billing properties; emit `matrix.beta.activated.v1` if checkout event did not already do it | `email`, `userId`, `subscriptionStatus`, `planName`, `trialEndsAt` | `stripe:{event.id}:sub_created_v1` | Use provider event ID plus template purpose to prevent duplicate activation sends. |
| Stripe `invoice.paid` | Update billing properties; emit `matrix.billing.succeeded.v1` | `email`, `userId`, `billingPeriodEnd`, `planName`, `billingPortalUrl`, `workspaceUrl` | `stripe:{event.id}:billing_ok_v1` | Never include full invoice payload or payment method details. Billing state stays canonical outside Loops. |
| Stripe `invoice.payment_failed` | Update billing state; emit `matrix.billing.payment_failed.v1` | `email`, `userId`, `retryAfter`, `billingPortalUrl`, `workspaceUrl`, `supportEmail` | `stripe:{event.id}:pay_failed_v1` | Payment failure email is important but still non-blocking. Retry Loops send; do not alter billing state based on Loops result. |
| Stripe `customer.subscription.updated` | Update billing properties; emit `matrix.billing.subscription_changed.v1` for plan/status/trial changes that are not cancellation | `email`, `userId`, `changeSummary`, `effectiveAt`, `billingPortalUrl` | `stripe:{event.id}:sub_changed_v1` | Collapse noisy updates with idempotency and a state-change guard so users do not receive duplicate minor-update emails. |
| Stripe `customer.subscription.deleted` | Update billing properties; emit `matrix.billing.subscription_canceled.v1` | `email`, `userId`, `accessEndsAt`, `billingPortalUrl`, `exportDocsUrl` | `stripe:{event.id}:sub_canceled_v1` | Preserve owner data. Email failure must not affect cancellation processing. |
| Stripe `customer.subscription.trial_will_end` | Optional reminder using `matrix.beta.activated.v1` variant or a future `matrix.billing.trial_ending.v1` template | `email`, `userId`, `trialEndsAt`, `billingPortalUrl`, `workspaceUrl` | `stripe:{event.id}:trial_end_v1` | Product decision needed before enabling, because the current template scope does not require a separate trial-ending email. |

### Matrix OS App / Backend Event Flow

| Source | Loops action | Required fields | Idempotency key | Failure behavior |
|--------|--------------|-----------------|-----------------|------------------|
| Onboarding goal selected | Update contact `matrixPrimaryGoal` and `matrixActivationStage` | `email`, `userId`, `primaryGoal`, `workspaceUrl` | `matrix:{eventId}:goal_v1` | Contact-property update only. Failure retries in background and must not block onboarding UI state. |
| CLI not activated after activation window | Emit `matrix.activation.cli_nudge.v1` | `email`, `userId`, `cliDocsUrl`, `workspaceUrl`, `matrixHandle` | `matrix:{eventId}:cli_nudge_v1` | Apply frequency cap and suppress if `matrixCliActivated` is true before send. |
| Cloud coding not activated after workspace-ready window | Emit `matrix.activation.cloud_coding_nudge.v1` | `email`, `userId`, `workspaceUrl`, `githubConnectUrl`, `primaryGoal` | `matrix:{eventId}:cloud_code_v1` | Apply frequency cap and suppress if first coding run has started. |
| Launch-critical operational failure | Emit `matrix.admin.launch_alert.v1` to internal recipients only | `alertType`, `safeSummary`, `adminConsoleUrl`, `occurredAt`, `severity`, `eventId` | `matrix:{eventId}:admin_alert_v1` | Admin alerts may retry. They must use safe summaries and point operators to the authenticated admin console for details. |

## Implementation Checklist For Follow-Up Code Work

- Create missing Loops contact properties listed in this plan.
- Create Loops templates or automations with the exact names in the naming table.
- Decide whether verification/sign-in product prompts are owned by Loops or stay entirely in Clerk.
- Decide whether billing events enter Matrix through direct Stripe webhooks, Clerk Billing webhooks, or Loops native Stripe automation, then document the single source of truth.
- Add a server-side Loops client or worker that uses environment-managed credentials only.
- Use 10 second timeouts for Loops API requests and keep calls server-side.
- Add an email-event outbox or equivalent retryable queue so webhook success paths are not blocked by Loops availability.
- Store or derive idempotency keys from provider event IDs and Matrix event IDs. Use the Loops `Idempotency-Key` header or CLI `--idempotency-key` equivalent for validation.
- Add route-boundary schema validation for webhook payloads and action-specific Matrix email events.
- Add tests for duplicate provider retries, Loops failure retries, suppression/frequency caps, and non-blocking auth/billing success paths.
- Add local/staging validation scripts that run read-only Loops CLI checks and never send to real customers.

## Local And Staging Validation

Safe read-only commands:

```bash
loops --version
loops agent-context --output json
loops auth status --output json
loops api-key --output json
loops transactional list --per-page 10 --output json
loops contact-properties list --custom --output json
loops lists list --output json
```

Staging-only validation after templates exist:

```bash
# Read template inventory only.
loops transactional list --per-page 20 --output json

# Validate event command shape without sending by inspecting CLI metadata.
loops agent-context --output json
```

Do not run `loops events send` or `loops transactional send` against the production team unless the recipient is an approved internal test address, the template is explicitly staged for testing, and no real customer automation can trigger.

## Product Decisions And Gaps

- Verification/sign-in ownership: Clerk should continue owning codes, magic links, and verification UI unless Matrix explicitly decides Loops should send product-only reminders.
- Billing source of truth: current shell copy references Clerk Billing, while the required flow names Stripe events. A follow-up must choose direct Stripe webhook relay, Clerk Billing webhook mapping, or Loops native Stripe automation as the operational source.
- Sender identity: final `fromName`, `fromEmail`, and `replyToEmail` are not chosen in this planning artifact.
- Receipt detail: Loops should not attach invoices unless billing/legal approves and Loops attachments are enabled for the account.
- Trial-ending reminder: Stripe supports `customer.subscription.trial_will_end`, but this ticket did not require a separate trial-ending template. Add only if launch wants that reminder.
- Frequency caps: exact timing for CLI and cloud-coding nudges needs product approval. Recommended starting point is one nudge after 24 hours and one follow-up after 72 hours, suppressed immediately when activation completes.
- Support/admin recipients: internal alert routing needs an owner, recipient list, and severity policy before live use.
