# Shared compute qualification setup

Scope: the isolated, gated preview in [ENG-319](https://linear.app/matrix-os/issue/ENG-319/ship-shared-workspace-alongside-personal-vps-runtimes), following the [production decision](./spec.md) and [compute admission design](./compute-admission.md). This is not a customer deployment or a free-plan grant. Existing personal VPS routing and entitlements remain unchanged.

## Initialize before enabling the Worker

Use a disposable PostgreSQL database and an operator-owned Kysely instance/pool. The older spike's two initializers are insufficient for admission-enabled code. Run these four initializers in order:

1. `PostgresWorkspaceRepository.initialize()` creates owner data tables.
2. `PostgresRuntimeStore.initialize()` creates runtime jobs and owner bindings.
3. `PostgresComputeBudgetStore.initialize()` creates allowance policies and reservations.
4. `PostgresComputeAdmissionStore.initialize()` creates accounts and the durable outbox, whose foreign keys depend on the preceding tables.

Then explicitly provision the test owner's policy window and allowance, and activate that account. The example accepts trusted operator inputs rather than embedding credentials or granting a default allowance:

```ts
import type { Kysely } from 'kysely';
import {
  PostgresWorkspaceRepository, admitWorkspaceChatMessage,
  type WorkspaceDatabase,
} from './packages/workspace-worker/src/data/repository.js';
import { PostgresRuntimeStore } from './packages/workspace-worker/src/data/runtime-store.js';
import {
  PostgresComputeBudgetStore, type ComputeBudgetDatabase,
  type ComputePolicyInput,
} from './packages/workspace-worker/src/data/compute-budget.js';
import {
  PostgresComputeAdmissionStore, type AdmissionDatabase,
} from './packages/workspace-worker/src/data/compute-admission.js';

type PreviewDatabase = WorkspaceDatabase & ComputeBudgetDatabase & AdmissionDatabase;

async function prepareSharedPreview(
  db: Kysely<PreviewDatabase>, policy: ComputePolicyInput, now: number,
): Promise<void> {
  // These are typed views of the same connection, never separate pools.
  const workspaceDb = db as unknown as Kysely<WorkspaceDatabase>;
  const budgetDb = db as unknown as Kysely<ComputeBudgetDatabase>;
  const repository = new PostgresWorkspaceRepository(workspaceDb, false);
  const budgets = new PostgresComputeBudgetStore(budgetDb);
  const admission = new PostgresComputeAdmissionStore(db, (trx, owner, input) =>
    admitWorkspaceChatMessage(trx as unknown as Kysely<WorkspaceDatabase>, owner, input));
  const runtime = new PostgresRuntimeStore(workspaceDb, admission.runtimeHooks());

  await repository.initialize();
  await runtime.initialize();
  await budgets.initialize();
  await admission.initialize();
  await budgets.provisionPolicy(policy);
  await admission.configureAccount({
    ownerId: policy.ownerId, periodId: policy.periodId, state: 'active',
  }, now);
}
```

The caller owns the injected connection and closes it after setup; these wrappers must not close a shared pool. Use the canonical `admitWorkspaceChatMessage` callback so Chat input joins the reservation/outbox transaction. Do not substitute a callback that opens another transaction or writes through an unrelated connection.

Choose explicit server-side `startsAt`, `endsAt`, `allowanceMs`, `ownerId` and `periodId`. The active window must cover the intended test; available allowance must cover the configured maximum task hold. A missing, expired, suspended or exhausted policy must deny new compute while saved-data reads still work. Browser plan labels and inference credit never provision compute authority. Policy provisioning and account activation are trusted server operations, not public HTTP endpoints.

## Bindings, credentials and recovery

Create fresh, uniquely scoped Worker, Queue and dead-letter Queue, Durable Object/container, R2 bucket, Hyperdrive connection and PostgreSQL resources. Bind them through an isolated configuration override rather than reusing customer resources. Keep configuration containing database connection details outside Git.

Enable the preview only for its exact test owner. Inject the approved preview access token, isolated runtime database credential and test inference credential through the secret manager; do not place them in the image, checkpoint, documentation, command arguments or captured logs. The preview credential resolver is explicitly owner-scoped. There is no production credential fallback: multi-owner production requires the separate owner credential broker and isolated databases. Compute allowance does not grant AI access or inference credit.

Deploy the Worker's minute cron as well as its Queue consumer. Scheduled recovery retries committed pending outbox delivery and re-arms runtime alarms; object cleanup remains hourly. PostgreSQL owns jobs, holds and generation fences. A successful Queue send, lease expiry or failed RPC is not proof of native termination and cannot refund uncertain work.

## Qualification and teardown

Use the actual Matrix gateway and a low-cost real agent. Verify saved-data reads with compute asleep; admission rollback and idempotency; exact Queue payload authority; model/tool waits through browser disconnect; checkpoint, destruction and restored Chat continuation; exhausted allowance without a compute wake; and personal VPS routing regressions. Record the exact code/image revision, observed failures, hold/settlement values and measured timings separately from assumptions. Shared support covers task-scoped work; independent daemons and persistent terminals require additional durable leases.

Keep raw credentials and private operator logs outside the public evidence. After measurements, stop and verify destruction of owned test compute, then remove only the isolated Worker and its secrets, Durable Object/container application, Queues, R2 objects/bucket, Hyperdrive connection, disposable database/roles and test image artifacts. Close local database pools and stop temporary servers. Preserve customer resources, unfinished feature work and the main checkout. Unconfirmed termination remains quarantined and held until reconciliation confirms native destruction; resource cleanup must not be presented as a refund or a successful restore.
