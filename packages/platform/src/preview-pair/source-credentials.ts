import { z } from "zod/v4";
import type { PreviewPairSourceProfile, PreviewPairSecretBinding } from "./source-profile.js";
import { PreviewPairConfigurationError } from "./config.js";
import { previewPairOperation } from "./operation.js";
import { loadTicketSigningKeyring } from "../collaboration/ticket-issuer.js";
export type PreviewPairSourceCredentials = Record<keyof PreviewPairSourceProfile["bindings"], string>;
function unavailable(): never { throw new PreviewPairConfigurationError(); }
function sameMaterial(left: string, right: string): boolean {
  return left === right || /^[A-Za-z0-9_-]{43}$/.test(left) && /^[A-Za-z0-9_-]{43}$/.test(right)
    && Buffer.from(left, "base64url").equals(Buffer.from(right, "base64url"));
}

/** Resolve before admission, never inside its transaction. These values stay in
 * the trusted source process; only approved candidate bindings reach its revision. */
export async function readPreviewPairSourceCredentials(profile: PreviewPairSourceProfile, control: NodeJS.ProcessEnv,
  read: (binding: PreviewPairSecretBinding, signal: AbortSignal) => Promise<string>): Promise<PreviewPairSourceCredentials> {
  const entries = await previewPairOperation(signal => Promise.all(Object.entries(profile.bindings)
    .map(async ([name, binding]) => [name, z.string().min(1).max(8192).parse(await read(binding, signal))] as const)));
  const values = Object.fromEntries(entries) as PreviewPairSourceCredentials;
  const preview = loadTicketSigningKeyring({ MATRIX_COLLABORATION_TICKET_KEYS: values.MATRIX_COLLABORATION_TICKET_KEYS,
    MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: profile.activeTicketKeyId });
  const existing = loadTicketSigningKeyring(control);
  if (!preview || control.MATRIX_COLLABORATION_TICKET_KEYS && !existing) unavailable();
  // The environment is source-owned. Protect other privileged keys too, not just
  // equal-named fields; a Preview host key must never contain a provider token.
  const reserved = Object.entries(control).filter(([name, value]) => value && /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|POSTGRES_URL/.test(name))
    .map(([, value]) => value!);
  reserved.push(profile.operatorSecret, ...Object.values({ ...existing?.keys, ...existing?.retired }));
  const forbidden = (value: string) => reserved.some(secret => sameMaterial(value, secret));
  if (!/^sk_test_[A-Za-z0-9_=-]{1,500}$/.test(values.CLERK_SECRET_KEY) || forbidden(values.CLERK_SECRET_KEY)) unavailable();
  const seeds = Object.values(preview.keys); // Keyring loader caps active+retired at eight.
  const secrets = [values.PLATFORM_SECRET, values.PLATFORM_JWT_SECRET, values.EDGE_ROUTER_SECRET];
  if (seeds.some(forbidden) || secrets.some((value, index) => value.length < 32 || value.length > 4096 || /\s/.test(value)
    || secrets.some((other, otherIndex) => otherIndex !== index && sameMaterial(value, other)) || forbidden(value)
    || [values.CLERK_SECRET_KEY, values.MATRIX_COLLABORATION_TICKET_KEYS, ...seeds].some(secret => sameMaterial(value, secret)))) unavailable();
  try {
    const url = new URL(values.PLATFORM_DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2
      || url.hash || forbidden(values.PLATFORM_DATABASE_URL)) unavailable();
  } catch (error: unknown) { if (error instanceof TypeError) unavailable(); throw error; }
  return values;
}
