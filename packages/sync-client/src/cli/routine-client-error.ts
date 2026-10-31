import { ROUTINE_CLI_SAFE_ERRORS, type RoutineCliErrorCode } from "@matrix-os/contracts/routine-cli";
export class RoutineClientError extends Error {
  constructor(readonly code: RoutineCliErrorCode) { super(ROUTINE_CLI_SAFE_ERRORS[code]); }
}
