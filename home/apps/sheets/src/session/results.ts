/** The results edit methods return, and the messages for refusals that have a known reason. */

import { toSessionError } from "./file-io";
import type { EditResult, SessionFailure } from "./types";

export const OK: EditResult = { ok: true };
export const PENDING_MESSAGE = "Accept or reject the proposed changes on this sheet first.";
export const ARRAY_MESSAGE = "This cell is part of an array formula. Change the whole range at once.";

/** A failure with a code and a message that are safe to show. */
export function failure(error: unknown): SessionFailure {
  const mapped = toSessionError(error);
  return { ok: false, code: mapped.code, message: mapped.message };
}
