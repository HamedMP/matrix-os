import type { McpProfileContext, MatrixMcpComputerList } from '@finnaai/matrix/mcp';
import { MatrixComputerRuntimeSlotSchema } from '@matrix-os/contracts';
import { getAccessibleRunningUserMachineByClerkId, type PlatformDB } from './db.js';
import { listUserRuntimeComputersByClerkId } from './computer-repository.js';
import { projectComputer } from './computer-routes.js';
import { issueSyncJwt } from './sync-jwt.js';
import type { McpPrincipal } from './mcp-auth.js';
import { getRuntimeEntitlementDecisionForUser } from './runtime-entitlement.js';

function failure(code: string): Error { return Object.assign(new Error('Matrix computer unavailable'), { code }); }

export function createMcpRuntimeContext(options: {
  db: PlatformDB; principal: McpPrincipal; gatewayOrigin: string; jwtSecret: string; env?: NodeJS.ProcessEnv;
}): McpProfileContext {
  const origin = new URL(options.gatewayOrigin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Invalid MCP gateway origin');
  }
  if (options.jwtSecret.length < 32) throw new Error('MCP runtime credentials unavailable');
  const { principal, db } = options;
  function remainingLifetime() {
    const seconds = principal.expiresAt - Math.floor(Date.now() / 1000);
    if (seconds <= 0) throw failure('auth_required');
    return Math.min(60, seconds);
  }
  async function listComputers(selectedSlot?: string): Promise<MatrixMcpComputerList> {
    remainingLifetime();
    const records = await listUserRuntimeComputersByClerkId(db, principal.userId, 21, selectedSlot);
    const computers = records.flatMap(record => {
      const projected = projectComputer(record);
      return projected ? [projected] : [];
    });
    return { items: computers.slice(0, 20), limit: 20, hasMore: computers.length > 20, selectedSlot: null };
  }
  return {
    listComputers,
    async resolveRuntime(input) {
      const slot = MatrixComputerRuntimeSlotSchema.parse(input);
      // Prioritize the explicit slot in the bounded query, independent of the first discovery page.
      const inventory = await listComputers(slot);
      const computer = inventory.items.find(item => item.runtimeSlot === slot);
      if (!computer) throw failure('computer_not_found');
      // Re-check authorization/state at every call; never cache an owner/runtime binding.
      const machine = await getAccessibleRunningUserMachineByClerkId(db, principal.userId, slot);
      if (!machine || machine.handle !== computer.handle) throw failure('computer_unavailable');
      const access = await getRuntimeEntitlementDecisionForUser(db, principal.userId,
        options.env ?? process.env, slot, machine.provisioningClass);
      if (!access.runtimeProxyAllowed) throw failure('billing_required');
      const gatewayUrl = new URL(computer.gatewayPath, origin).toString();
      const issued = await issueSyncJwt({ secret: options.jwtSecret, clerkUserId: principal.userId,
        handle: machine.handle, runtimeSlot: slot, gatewayUrl, expiresInSec: remainingLifetime() });
      return { computer, gatewayUrl, token: issued.token };
    },
  };
}
