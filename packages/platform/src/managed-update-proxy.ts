import type { PlatformDB } from './db.js';
import { readMachineOverride } from './backend-management-repository.js';

/** Must run after resolving an authorized machine and before proxying a user
 * request: older gateways cannot distinguish the platform-injected bearer. */
export async function allowManagedUpdateProxy(db: PlatformDB, machineId: string, method: string, rawPath: string): Promise<boolean> {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  let path: string;
  try { path = decodeURIComponent(rawPath).replace(/^\/vm\/[^/]+/, ''); }
  catch (err: unknown) { if (err instanceof URIError) return false; throw err; }
  if (!/^\/api\/(?:system\/(?:update(?:\/repair)?|upgrade)|internal\/upgrade)\/?$/.test(path)) return true;
  return (await readMachineOverride(db, machineId)).versionSelectionAllowed;
}
