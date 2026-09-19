import { createHmac, timingSafeEqual } from "node:crypto";

export const PREVIEW_TERMINAL_ACCESS_HEADER = "x-platform-preview-terminal";
export const PREVIEW_TERMINAL_OWNER_CONTEXT_KEY = "previewTerminalOwner";

export function verifyPreviewTerminalAccess(options: {
  value: string | undefined;
  key: string;
  actorId: string;
  configuredOwnerIds: readonly (string | undefined)[];
  runtimeSlot: string | undefined;
}): string | undefined {
  const { value, key, actorId, runtimeSlot } = options;
  if (!value || value.length > 512 || !key || !runtimeSlot) return undefined;
  const match = /^([A-Za-z0-9_-]{1,256})\.([a-f0-9]{64})$/.exec(value);
  if (!match || match[1] === actorId) return undefined;
  const owners = options.configuredOwnerIds
    .map((ownerId) => ownerId?.trim())
    .filter((ownerId, index, all): ownerId is string => Boolean(ownerId) && all.indexOf(ownerId) === index);
  if (owners.length !== 1 || owners[0] !== match[1]) return undefined;
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(["preview-terminal", actorId, match[1], runtimeSlot]))
    .digest();
  const actual = Buffer.from(match[2], "hex");
  return timingSafeEqual(actual, expected) ? match[1] : undefined;
}
