import { defineCommand } from "citty";
import { RoutineCliResultSchema, ROUTINE_CLI_SAFE_ERRORS } from "@matrix-os/contracts/routine-cli";
import { routineOperationFromCitty } from "../routine-input.js";
import { executeRoutineOperation, RoutineClientError } from "../routine-client.js";
import { formatRoutineHuman, routineExitCode } from "../routine-output.js";
import { formatCliSuccess, formatCliError } from "../output.js";
export const routinesCommand = defineCommand({
  meta: { name: "routines", description: "Source-bound routines: list; show <routineId>; request <uuid>; propose --input - --request-id <uuid>; pause/resume/archive <routineId> --revision <integer> --request-id <uuid>. Choose this Computer's destination in a private Bot Chat's Details > Routine destination. Requires an authorized Matrix source context; owner login/profile is insufficient. Queued is admission history, not pending approval or active. Stop/unknown effects stay unconfirmed; reconcile using request(original UUID). No automatic mutation retry." },
  args: { verb: { type: "positional", required: false }, operand: { type: "positional", required: false },
    input: { type: "string", description: "Strict proposal JSON on bounded stdin (- only)" },
    "request-id": { type: "string", description: "Explicit stable mutation UUID; reuse original to reconcile" },
    revision: { type: "string", description: "Current integer routine revision" }, json: { type: "boolean", default: false } },
  async run({ args, rawArgs }) {
    const machine = rawArgs.includes("--json"), controller = new AbortController();
    const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const operation = await routineOperationFromCitty(rawArgs, args);
      const result = RoutineCliResultSchema.parse(await executeRoutineOperation(operation, controller.signal));
      console.log(machine ? formatCliSuccess(result) : formatRoutineHuman(result)); process.exitCode = routineExitCode(result);
    } catch (error: unknown) {
      const code = error instanceof RoutineClientError ? error.code : "invalid_input";
      console.log(machine ? formatCliError(code, ROUTINE_CLI_SAFE_ERRORS[code]) : ROUTINE_CLI_SAFE_ERRORS[code]); process.exitCode = routineExitCode(code);
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); if (process.connected && typeof process.disconnect === "function") process.disconnect(); }
  },
});
