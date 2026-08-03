import { z } from 'zod/v4';
import type { UserMachineRecord } from './db.js';
import {
  PreviewRuntimeSlotSchema,
  PublicIPv4Schema,
} from './customer-vps-schema.js';

const PreviewVmRouteEnvSchema = z.object({
  PLATFORM_PREVIEW: z.literal('true'),
  PLATFORM_PREVIEW_ROUTE_MACHINE_ID: z.uuid(),
  PLATFORM_PREVIEW_ROUTE_HANDLE: PreviewRuntimeSlotSchema,
  PLATFORM_PREVIEW_ROUTE_IPV4: PublicIPv4Schema,
  PLATFORM_PREVIEW_ROUTE_IMAGE_VERSION: z.string().min(1).max(128).optional(),
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

  return {
    machineId: route.PLATFORM_PREVIEW_ROUTE_MACHINE_ID,
    clerkUserId: `preview_${route.PLATFORM_PREVIEW_ROUTE_HANDLE}`,
    handle: route.PLATFORM_PREVIEW_ROUTE_HANDLE,
    runtimeSlot: route.PLATFORM_PREVIEW_ROUTE_HANDLE,
    provisioningClass: 'preview',
    accessClerkUserIds: [],
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
