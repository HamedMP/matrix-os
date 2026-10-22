import { createHash } from "node:crypto";

const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Stable public receipt ID shared by broker requests and progress events.
 * Pi Responses IDs can join call and item IDs with `|`; hash the entire ID
 * without truncating or revealing it. Pi's own messages keep the original ID.
 */
export function bridgeToolCallId(sdkId: string): string {
  return SAFE_CALL_ID.test(sdkId)
    ? sdkId
    : `call_${createHash("sha256").update(sdkId).digest("hex")}`;
}
