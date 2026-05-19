# User Operations Runbook

This runbook covers waitlist users, approvals, provisioning, support debugging,
PostHog monitoring, and outbound email. It is for operators and engineers
working on signup, onboarding, customer VPS provisioning, and customer support.

## Current Signup Shape

Current production flow:

```text
matrix-os.com signup / Clerk
  -> Clerk user.created webhook
  -> Inngest `provision-matrix-os`
  -> POST /containers/provision on platform
  -> with CUSTOMER_VPS_ENABLED=true, platform provisions/reuses customer VPS
  -> user opens app.matrix-os.com / code.matrix-os.com through Clerk session
```

Important code paths:

- `www/src/inngest/provision-user.ts`
- `www/src/inngest/provision-status.ts`
- `www/src/app/dashboard/actions.ts`
- `packages/platform/src/main.ts` (`/containers/provision`)
- `packages/platform/src/customer-vps-routes.ts` (`/vps/*`)

`/containers/provision` remains the compatibility entry point because the
website/Inngest path already calls it. In production with
`CUSTOMER_VPS_ENABLED=true`, it delegates to the VPS-per-user path and returns
`runtime: "customer_vps"`.

## Inngest In Matrix

Inngest is the durable workflow layer for website/control-plane events that need
retries, sleeps, replayable steps, and operator visibility. It currently lives
in `www/` and is exposed through `www/src/app/api/inngest/route.ts`.

Current files:

- `www/src/inngest/client.ts` creates the `matrix-os` Inngest client.
- `www/src/app/api/inngest/route.ts` serves functions with `inngest/next`.
- `www/src/inngest/provision-user.ts` handles `clerk/user.created`.
- `www/src/inngest/provision-status.ts` keeps provisioning verification helpers.

Use Inngest when:

- a workflow starts from an external product event such as Clerk, Stripe,
  waitlist approval, or a future email event;
- the workflow should survive serverless restarts or deploys;
- a task needs durable `step.run(...)` boundaries, retry visibility, or
  `step.sleep(...)`;
- partial progress should not be repeated after a retry;
- operators need a per-user run history for debugging.

Do not use Inngest when:

- the user needs an immediate synchronous response from an API route;
- the work belongs inside the owner VPS runtime, Matrix gateway, Symphony
  poller, or local agent session;
- the task needs direct access to customer VPS local files or local Postgres;
- a simple platform route plus transaction is enough.

Design rules:

- Every event must include a stable idempotency key where duplicates are
  possible. For user provisioning, the Clerk user ID is the logical key and the
  platform provisioning path is idempotent by `clerkUserId`.
- Every `step.run` must be safe to retry or must call an idempotent platform API.
- External calls use `AbortSignal.timeout(...)`.
- Provider/platform raw errors are captured for operators but mapped to generic
  user-facing states.
- PostHog events should be emitted at start, failure, delayed/booting, and
  completion points.
- Secrets stay in the website/platform environment. Do not forward
  `PLATFORM_SECRET`, Clerk secrets, or email provider tokens to customer VPSes or
  agent sessions.

Current Inngest setup:

```typescript
// www/src/app/api/inngest/route.ts
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [provisionUser],
});
```

```typescript
// www/src/inngest/provision-user.ts
export const provisionUser = inngest.createFunction(
  { id: "provision-matrix-os" },
  { event: "clerk/user.created" },
  async ({ event, step }) => {
    const provisionResult = await step.run("provision-container", async () => {
      // Calls platform /containers/provision with timeout.
    });

    await step.sleep("wait-for-boot", "10s");

    await step.run("verify-running", async () => {
      // Verifies customer VPS or legacy container status.
    });
  },
);
```

Good future Inngest workflows:

- `clerk/waitlist.approved` or operator-created approval event -> send invite
  and provision after signup.
- `matrix/provision.retry_requested` -> retry a failed provisioning run.
- `matrix/email.send_requested` -> send templated product email through the
  platform email provider.
- `stripe/subscription.updated` -> reconcile billing entitlement and Matrix org
  access.
- `matrix/user.deprovision_requested` -> revoke access, schedule backup/export,
  and eventually delete resources after a retention delay.

Bad Inngest fits:

- Symphony's Linear polling loop.
- Customer VPS systemd health checks.
- Gateway request handlers.
- Per-message Matrix/Hermes automations that require owner-local runtime state.

## Waitlist Approval Flow

Use Clerk Waitlist mode for closed access. Clerk's waitlist lets users register
interest, and operators approve or deny access from the Clerk Dashboard.

Operator flow:

1. Check capacity before approval:
   - Hetzner quota and budget.
   - Current `matrix_vps_info` and `matrix_vps_healthy` fleet health.
   - Latest `dev`/`canary` release health if approving into a dogfood cohort.
2. In Clerk Dashboard, open **Waitlist**.
3. Review the user email, requested context, and any internal notes.
4. Approve by inviting the user, or deny if they should not receive access.
5. After invite, the user signs up through Clerk.
6. The `clerk/user.created` Inngest function provisions their Matrix instance.
7. Confirm PostHog and platform status show the provision as started and usable.

Approval rules:

- Founder/operator approval is enough for internal dogfood users.
- Engineering lead or release owner approval is required for external users when
  capacity, release channel, or support load is uncertain.
- Do not approve users into broad production if `stable` fleet health is
  degraded or if host-bundle rollback is active.
- Do not manually create a customer VPS before a Clerk user exists unless this
  is an explicit support recovery action.

Clerk can send its own invite/access email when a waitlist entry is approved.
Matrix outbound email is still planned; see "Outbound Email Plan" below.

## Provisioning A User

Preferred path:

1. Approve/invite in Clerk.
2. Let the user sign up.
3. Let Inngest handle `clerk/user.created`.

Manual retry for an existing Clerk user:

```bash
curl --fail --silent --show-error \
  -X POST "$PLATFORM_PUBLIC_URL/containers/provision" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"handle":"<handle>","clerkUserId":"<clerk_user_id>","displayName":"<name>"}'
```

Manual VPS status:

```bash
curl --fail --silent --show-error \
  "$PLATFORM_PUBLIC_URL/vps/<machine_id>/status" \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

Platform DB check:

```bash
psql "$PLATFORM_DATABASE_URL" -c "
  SELECT id, clerk_user_id, handle, status, public_ipv4, image_version, last_seen_at
  FROM user_machines
  WHERE clerk_user_id = '<clerk_user_id>' OR handle = '<handle>'
  ORDER BY created_at DESC;
"
```

Customer VPS check:

```bash
ssh matrix@<customer-vps-ip> '
  cat /opt/matrix/app/BUNDLE_VERSION
  cat /opt/matrix/release.json
  systemctl is-active matrix-gateway matrix-shell matrix-code matrix-sync-agent
  curl -fsS http://127.0.0.1:4000/health
'
```

## Debugging User Access

Start from the user's Clerk ID and handle.

1. **Clerk**
   - Confirm the user exists and is not still waiting for access.
   - Confirm primary email and username/handle.
   - Confirm session works on `matrix-os.com` and `app.matrix-os.com`.
2. **PostHog**
   - Search by Clerk user ID as `distinctId`.
   - Check `provision_requested`, `provision_completed`, `provision_failed`,
     `inngest_provision_started`, `inngest_provision_completed`,
     `inngest_provision_booting`, and `inngest_provision_failed`.
3. **Inngest**
   - Inspect the `provision-matrix-os` run for the Clerk user.
   - Confirm `provision-container` and `verify-running` steps.
   - Retry the function only after confirming the platform operation is
     idempotent for that user.
   - If the run failed after `provision-container`, check whether a
     `user_machines` row already exists before retrying.
4. **Platform**
   - Query `user_machines` for active VPS rows.
   - Check `matrix-platform.service` logs for provisioning, registration, and
     routing errors.
   - Check Grafana VPS Fleet Overview for fleet-level degradation.
5. **Customer VPS**
   - Check release version and systemd service health.
   - Check gateway `/health`.
   - Check `/opt/matrix/env/host.env` has `PLATFORM_INTERNAL_URL`,
     `UPGRADE_TOKEN`, `MATRIX_HANDLE`, and `DATABASE_URL`.

Common symptoms:

| Symptom | Likely cause | First check |
| --- | --- | --- |
| User cannot sign up | Still waitlisted or Clerk domain/session config issue | Clerk Waitlist and Clerk Domains |
| Dashboard shows no instance | Inngest did not run or platform provision failed | PostHog events and Inngest run |
| `app.matrix-os.com` redirects to dashboard | No running/active `user_machines` row for Clerk ID | Platform DB and `/vps/:machineId/status` |
| 502 after routing | Target VPS shell/gateway/code service unhealthy | VPS systemd and `curl :4000/health` |
| Shell loads old Clerk or JS errors | Host bundle built with wrong public env or stale release | `/opt/matrix/release.json`, browser console |
| Integrations 404 on customer VPS | Missing `PLATFORM_INTERNAL_URL` or platform integration route issue | VPS `host.env`, platform integration logs |

## PostHog Monitoring

Use PostHog for product and provisioning errors; use Grafana/Prometheus for
runtime health.

Primary PostHog identifiers:

- `distinctId`: Clerk user ID.
- properties: `handle`, `source`, `runtime`, `machine_status`,
  `instance_status`, `instance_runtime`, `has_instance`.

Provisioning events currently emitted:

| Event | Meaning |
| --- | --- |
| `provision_requested` | User clicked the dashboard provision button. |
| `provision_completed` | Dashboard server action provisioned successfully. |
| `provision_failed` | Dashboard server action failed. |
| `inngest_provision_started` | Clerk `user.created` provisioning function started. |
| `inngest_provision_completed` | Inngest verified a running instance. |
| `inngest_provision_booting` | Customer VPS exists but is still booting/recovering. |
| `inngest_provision_failed` | Inngest provisioning failed. |

Error monitoring routine:

1. Open PostHog and filter by `distinctId = <clerk_user_id>`.
2. Check recent exceptions and provisioning events.
3. Compare event timestamps with Inngest logs and platform systemd logs.
4. If the issue is runtime health, switch to Grafana and VPS logs.
5. If an error contains provider names, raw DB errors, paths, or secrets, fix
   the code path; client-visible errors must stay generic.

Keep dashboards for:

- signup to waitlist join;
- waitlist invite to signup;
- signup to provision started;
- provision started to usable VPS;
- provision failure rate by release version;
- first open of `app.matrix-os.com`;
- first successful gateway health from the user's VPS.

## Outbound Email Plan

Current state:

- Clerk can send waitlist invite/access emails when an operator invites a
  waitlist user.
- Matrix does not yet have a first-party outbound email provider abstraction.

Planned provider:

- Use Cloudflare Email Service for outbound product email.
- Keep all email sending platform-owned. Do not send product email directly from
  customer VPSes or coding-agent sessions.
- Use Email Routing only for inbound/forwarded addresses such as
  `support@matrix-os.com`; Email Routing by itself is not outbound SMTP.

Cloudflare split:

| Cloudflare product | Use for Matrix | Notes |
| --- | --- | --- |
| Email Routing | Inbound support/ops aliases and Email Workers for inbound processing | Forwarding/inbound path, not product email sending by itself. |
| Email Service | Outbound transactional/product email via REST API or Workers binding | Candidate for invites, provisioning updates, and support messages. |

Suggested platform abstraction:

```text
packages/platform/src/email/
  contracts.ts          # Zod schemas for email intent
  provider.ts           # MatrixEmailProvider interface
  cloudflare.ts         # Cloudflare Email Service REST implementation
  templates.ts          # plain text + HTML templates
  routes.ts             # operator-only test/send endpoints
```

Required email types:

- waitlist approved / invite fallback;
- instance provisioning started;
- instance ready;
- provisioning delayed;
- provisioning failed and support follow-up;
- release incident or planned maintenance;
- billing and account notices later.

Security rules:

- Email API tokens stay on the platform only.
- Emails must use allowlisted templates and sender addresses.
- User-supplied text is escaped before entering HTML.
- Every send has an idempotency key, rate limit, and audit event.
- No provider raw error is shown to users.
- Failed sends are logged and visible to operators.

Proposed env:

```bash
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_EMAIL_API_TOKEN=
CLOUDFLARE_EMAIL_FROM=team@matrix-os.com
CLOUDFLARE_EMAIL_REPLY_TO=support@matrix-os.com
```

Do not add these to customer VPS env files.

## Sources

- Clerk Waitlist docs: https://clerk.com/docs/components/waitlist/overview
- Clerk Waitlist management docs: https://clerk.com/docs/chrome-extension/guides/secure/waitlist
- Cloudflare Email Routing docs: https://developers.cloudflare.com/email-routing/get-started/
- Cloudflare Email Service send docs: https://developers.cloudflare.com/email-service/get-started/send-emails/
