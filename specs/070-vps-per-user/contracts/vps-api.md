# Contract: Platform VPS API

Base path: platform service, internal/admin only.

All mutating endpoints use `bodyLimit({ maxSize: 4096 })`. All request bodies are validated with Zod 4. Client responses never include raw Hetzner, R2, filesystem, or database error text.

## Auth

| Route | Auth |
|-------|------|
| `POST /vps/provision` | `Authorization: Bearer <PLATFORM_SECRET>` |
| `POST /vps/register` | `Authorization: Bearer <one-time-registration-token>` |
| `POST /vps/recover` | `Authorization: Bearer <PLATFORM_SECRET>` |
| `GET /vps/:machineId/status` | `Authorization: Bearer <PLATFORM_SECRET>` |
| `DELETE /vps/:machineId` | `Authorization: Bearer <PLATFORM_SECRET>` |

Secret comparisons must use `timingSafeEqual` over equal-length buffers.

## POST /vps/provision

Create or return the user's customer VPS. Idempotent by `clerkUserId`.

### Request

```typescript
{
  clerkUserId: string;
  handle: string;
}
```

### Validation

```typescript
import { z } from "zod/v4";

const ProvisionRequestSchema = z.object({
  clerkUserId: z.string().min(3).max(256),
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
});
```

### Response 202

```typescript
{
  machineId: string;
  status: "provisioning" | "running";
  etaSeconds: number;
}
```

### Errors

- `400`: invalid request
- `401`: missing/invalid platform secret
- `409`: existing machine is in an incompatible state
- `429`: Hetzner quota/capacity guard hit
- `500`: generic provisioning failure

### Required Behavior

1. Lookup or create `userMachines` row by `clerkUserId`.
2. If an active row already exists, return its `machineId` and `status`.
3. Generate one-time registration token and store only its hash.
4. Render cloud-init using fixed server type/location/image from config.
5. Call Hetzner create with `AbortSignal.timeout(10_000)`.
6. Store `hetznerServerId` and stay in `provisioning`.

No Hetzner call may occur while holding a DB transaction open.

## POST /vps/register

Called once by customer VPS after first boot and restore/fresh gate.

### Request

```typescript
{
  machineId: string;
  hetznerServerId: number;
  publicIPv4: string;
  publicIPv6?: string;
  imageVersion: string;
}
```

### Response 200

```typescript
{
  registered: true;
  status: "running";
}
```

### Errors

- `400`: invalid request
- `401`: invalid/expired registration token
- `404`: unknown machine
- `409`: machine cannot register from current state
- `500`: generic registration failure

### Required Behavior

1. Validate token hash with constant-time comparison.
2. Verify `machineId` and `hetznerServerId` match the row.
3. Transactionally update row to `running`, set IPs, `imageVersion`, `lastSeenAt`, and clear registration token fields.
4. Write `system/vps-meta.json` to R2 after the row update. If R2 write fails, keep row `running` but log and surface degraded status in operator checks.

## POST /vps/recover

Replace a VPS from R2 state. Phase 1 manual/admin only.

### Request

```typescript
{
  clerkUserId: string;
  allowEmpty?: boolean;
}
```

### Response 202

```typescript
{
  oldMachineId: string | null;
  machineId: string;
  status: "recovering";
  etaSeconds: number;
}
```

### Required Behavior

1. Unless `allowEmpty` is true, verify R2 has `system/db/latest` for the user.
2. Mark existing active row `recovering`.
3. Delete old Hetzner server if present.
4. Create a new server with new `machineId` and registration token.
5. Replacement boot performs restore before gateway starts.

## GET /vps/:machineId/status

### Response 200

```typescript
{
  machineId: string;
  clerkUserId: string;
  handle: string;
  status: "provisioning" | "running" | "failed" | "recovering" | "deleted";
  imageVersion?: string;
  publicIPv4?: string;
  publicIPv6?: string;
  provisionedAt: string;
  lastSeenAt?: string;
  deletedAt?: string;
  failureCode?: string;
}
```

## DELETE /vps/:machineId

Admin-only explicit deletion.

### Response 200

```typescript
{
  deleted: true;
  machineId: string;
  status: "deleted";
}
```

### Required Behavior

1. Find non-deleted row.
2. Delete Hetzner server if `hetznerServerId` exists.
3. Soft-delete row with `deletedAt`.
4. Never delete R2 user data in phase 1.
