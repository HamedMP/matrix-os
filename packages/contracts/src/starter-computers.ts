import { z } from 'zod/v4';
import {
  MatrixComputerSchema, MatrixComputerHandleSchema, MatrixComputerRuntimeSlotSchema,
  MatrixComputerAvailabilitySchema, MatrixComputerCapabilityIdSchema, MatrixComputerVersionLabelSchema,
} from './index.js';

/** Opt-in Web projection. Native clients retain the existing VPS-only contract. */
export const StarterComputerSchema = z.object({
  handle: MatrixComputerHandleSchema,
  runtimeSlot: z.literal('starter'), label: z.literal('Starter Computer'), kind: z.literal('starter'),
  availability: MatrixComputerAvailabilitySchema,
  gatewayPath: z.literal('/workspace'),
  versionLabel: MatrixComputerVersionLabelSchema.optional(),
  capabilities: z.array(MatrixComputerCapabilityIdSchema).max(64),
}).strict();
export const WebComputerSchema = z.union([MatrixComputerSchema, StarterComputerSchema]);
export const WebComputerListSchema = z.object({
  items: z.array(WebComputerSchema).max(20),
  hasMore: z.boolean(), limit: z.number().int().min(1).max(20),
  selectedSlot: MatrixComputerRuntimeSlotSchema.nullable(),
}).strict()
  .refine((list) => list.items.length <= list.limit, { message: 'Computer inventory exceeds its limit' })
  .refine((list) => new Set(list.items.map((item) => item.runtimeSlot)).size === list.items.length, { message: 'Duplicate computer slot' })
  .refine((list) => list.selectedSlot === null || list.items.some((item) => item.runtimeSlot === list.selectedSlot), { message: 'Selected computer is missing' });
export type WebComputer = z.infer<typeof WebComputerSchema>;
export type WebComputerList = z.infer<typeof WebComputerListSchema>;
export const WEB_COMPUTER_INVENTORY_PATH = '/api/auth/computers?include=starter';

const PilotComputerSchema = z.object({
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  handle: MatrixComputerHandleSchema,
  origin: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    } catch (error: unknown) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  }).transform((value) => new URL(value).origin),
  token: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const PilotRegistrySchema = z.array(PilotComputerSchema).min(1).max(2).refine((entries) =>
  ['ownerId', 'origin', 'token'].every((key) => new Set(entries.map((entry) => entry[key as keyof typeof entry])).size === entries.length),
  { message: 'Pilot owners must use separate origins and credentials' });

/** Private server input only. Callers must never serialize this return value. */
export function starterPilotForOwner(raw: string | undefined, ownerId: string): z.infer<typeof PilotComputerSchema> | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > 16_384) throw new Error('Starter computer configuration unavailable');
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) throw new Error('Starter computer configuration unavailable');
    throw error;
  }
  const parsed = PilotRegistrySchema.safeParse(value);
  if (!parsed.success) throw new Error('Starter computer configuration unavailable');
  return parsed.data.find((entry) => entry.ownerId === ownerId);
}

export function starterComputerProjection(handle: string): z.infer<typeof StarterComputerSchema> {
  return StarterComputerSchema.parse({ handle, runtimeSlot: 'starter', label: 'Starter Computer', kind: 'starter',
    availability: 'available', gatewayPath: '/workspace', capabilities: ['starterComputerWebV1'] });
}

export function isStarterWorkspacePath(path: string): boolean {
  return path === '/workspace' || path.startsWith('/workspace/')
    || path === '/__shared-workspace' || path.startsWith('/__shared-workspace/');
}
