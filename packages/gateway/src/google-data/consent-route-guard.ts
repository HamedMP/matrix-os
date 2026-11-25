import type { Context } from "hono";
import {
  getOptionalRequestPrincipal,
  isInteractiveOwnerPrincipal,
  isRequestPrincipalError,
  mapRequestPrincipalError,
} from "../request-principal.js";

const CONSENT_PATH = /\/gmail\/+processing-consents(?:[/?#]|$)/i;

function namesConsentPath(c: Context): boolean {
  const raw = new URL(c.req.url).pathname;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); }
  catch (error: unknown) {
    if (!(error instanceof URIError)) throw error;
    // An undecodable alias cannot be classified, so treat it as the consent route.
    return true;
  }
  return [c.req.path, raw, decoded].some(path => CONSENT_PATH.test(path));
}

/**
 * Gmail processing consent is the owner's own affirmative answer. Agent run
 * bearers (Hermes, Matrix MCP) and the owner machine bearer can read the
 * revisions it needs, so they must never record or revoke it over HTTP. The
 * managed Pi approval prompt records consent through its server-side
 * integration transport, not this public route. Call after auth and bodyLimit,
 * before local execution or Platform forwarding.
 */
export function denyNonInteractiveGmailConsentMutation(c: Context): Response | null {
  if (c.req.method === "GET" || c.req.method === "HEAD" || !namesConsentPath(c)) return null;
  c.header("Cache-Control", "no-store");
  let principal;
  try { principal = getOptionalRequestPrincipal(c); }
  catch (error: unknown) {
    if (!isRequestPrincipalError(error)) throw error;
    const mapped = mapRequestPrincipalError(error, "Gmail data settings unavailable");
    if (mapped.log) console.warn("[google-data] Consent principal unavailable:", error.name);
    return c.json(mapped.body, mapped.status);
  }
  return isInteractiveOwnerPrincipal(c, principal) ? null : c.json({ error: "Forbidden" }, 403);
}
