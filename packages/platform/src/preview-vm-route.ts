import { z } from 'zod/v4';
import type { UserMachineRecord } from './db.js';
import {
  ClerkUserIdSchema,
  PreviewProvisionRequestSchema,
  PreviewRuntimeSlotSchema,
  PublicIPv4Schema,
} from './customer-vps-schema.js';

const PreviewVmRouteEnvSchema = z.object({
  PLATFORM_PREVIEW: z.literal('true'),
  PLATFORM_PREVIEW_ROUTE_MACHINE_ID: z.uuid(),
  PLATFORM_PREVIEW_ROUTE_HANDLE: PreviewRuntimeSlotSchema,
  PLATFORM_PREVIEW_ROUTE_IPV4: PublicIPv4Schema,
  PLATFORM_PREVIEW_ROUTE_IMAGE_VERSION: z.string().min(1).max(128).optional(),
  PLATFORM_PREVIEW_ROUTE_OWNER_CLERK_USER_ID: ClerkUserIdSchema,
  PLATFORM_PREVIEW_ROUTE_ACCESS_CLERK_USER_IDS: z.string().max(2055).regex(
    /^(?:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)?$/,
  ),
});

export function resolvePreviewVmRoute(
  env: NodeJS.ProcessEnv,
  handle: string,
  runtimeSlot?: string,
): UserMachineRecord | null {
  const parsed = PreviewVmRouteEnvSchema.safeParse(env);
  if (!parsed.success) return null;

  const route = parsed.data;
  if (handle !== route.PLATFORM_PREVIEW_ROUTE_HANDLE) return null;
  if (runtimeSlot && runtimeSlot !== route.PLATFORM_PREVIEW_ROUTE_HANDLE) return null;
  const accessClerkUserIds = route.PLATFORM_PREVIEW_ROUTE_ACCESS_CLERK_USER_IDS
    ? route.PLATFORM_PREVIEW_ROUTE_ACCESS_CLERK_USER_IDS.split(':')
    : [];
  const identity = PreviewProvisionRequestSchema.safeParse({
    clerkUserId: route.PLATFORM_PREVIEW_ROUTE_OWNER_CLERK_USER_ID,
    handle: route.PLATFORM_PREVIEW_ROUTE_HANDLE,
    runtimeSlot: route.PLATFORM_PREVIEW_ROUTE_HANDLE,
    accessClerkUserIds,
  });
  if (!identity.success) return null;

  return {
    machineId: route.PLATFORM_PREVIEW_ROUTE_MACHINE_ID,
    clerkUserId: identity.data.clerkUserId,
    handle: route.PLATFORM_PREVIEW_ROUTE_HANDLE,
    runtimeSlot: route.PLATFORM_PREVIEW_ROUTE_HANDLE,
    provisioningClass: 'preview',
    accessClerkUserIds: identity.data.accessClerkUserIds,
    developerTools: [],
    hetznerServerId: null,
    publicIPv4: route.PLATFORM_PREVIEW_ROUTE_IPV4,
    publicIPv6: null,
    status: 'running',
    imageVersion: route.PLATFORM_PREVIEW_ROUTE_IMAGE_VERSION ?? null,
    serverType: null,
    location: null,
    registrationTokenHash: null,
    registrationTokenExpiresAt: null,
    provisionedAt: '1970-01-01T00:00:00.000Z',
    lastSeenAt: null,
    deletedAt: null,
    failureCode: null,
    failureAt: null,
    resizeStartedAt: null,
    resizeTargetServerType: null,
    attempt: 1,
  };
}
