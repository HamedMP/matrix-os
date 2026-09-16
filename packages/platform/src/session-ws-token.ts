/**
 * WebSocket token issuance handler.
 *
 * Extracted from ./session-routing-middleware.ts (Phase 1-A4). Pure move: no logic changes.
 */

import type { Context } from 'hono';
import type { CreateSessionRoutingMiddlewareOpts } from './session-routing-middleware.js';
import { issueSyncJwt } from './sync-jwt.js';

export interface WsTokenDeps {
  applyNoStoreHeaders: CreateSessionRoutingMiddlewareOpts['applyNoStoreHeaders'];
  platformJwtSecret: string;
  getGatewayUrlForHandle: CreateSessionRoutingMiddlewareOpts['getGatewayUrlForHandle'];
  wsTokenExpiresInSec: number;
}

export function createWsTokenIssuer(deps: WsTokenDeps) {
  const {
    applyNoStoreHeaders,
    platformJwtSecret,
    getGatewayUrlForHandle,
    wsTokenExpiresInSec,
  } = deps;
  async function issueWebSocketTokenResponse(
    c: Context,
    target: { clerkUserId: string; handle: string; runtimeSlot?: string },
  ): Promise<Response> {
    applyNoStoreHeaders(c);
    if (!platformJwtSecret) {
      return c.json({ error: 'WebSocket auth unavailable' }, 503);
    }
    const issued = await issueSyncJwt({
      secret: platformJwtSecret,
      clerkUserId: target.clerkUserId,
      handle: target.handle,
      gatewayUrl: getGatewayUrlForHandle(target.handle),
      runtimeSlot: target.runtimeSlot,
      expiresInSec: wsTokenExpiresInSec,
    });
    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
    });
  }
  return { issueWebSocketTokenResponse };
}
