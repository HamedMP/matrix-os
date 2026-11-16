import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, basename } from "node:path";
import { statSync } from "node:fs";
import { routineCliResultMatchesOperation, RoutineCliChildFrameSchema, RoutineCliOperationSchema, RoutineCliEnvelopeSchema, RoutineCliEndpointSchema, RoutineCliTokenSchema,
  ROUTINE_CLI_FRAME_BYTES, ROUTINE_CLI_INPUT_BYTES, ROUTINE_CLI_OUTPUT_BYTES, ROUTINE_CLI_SAFE_ERRORS,
  type RoutineCliEnvelope, type RoutineCliOperation, RoutineCliErrorCodeSchema } from "@matrix-os/contracts/routine-cli";
export interface FixedNativeRoutineCliDependencies {
  binPath: string; endpoint: string;
  /** Trusted host working directory; never read from CLI args or operation payload. */
  cwd?: string;
  homePath?: string;
  authorize(input: { operation: RoutineCliOperation; invocationId: string; signal: AbortSignal }): Promise<boolean>;
  issue(input: { operation: RoutineCliOperation; invocationId: string; signal: AbortSignal }): Promise<{ takeToken(): string }>;
  /** Invocation-local cleanup/unused-cap revocation only; NEVER revoke the original source on CLI exit,
   * cancel a target task or equate a transport ACK with stopped execution. Must honor bounded abort/drain. */
  cancel(input: { operation?: RoutineCliOperation; invocationId: string; reason: "finished" | "aborted" | "timeout" | "protocol_error" | "shutdown" }): Promise<void>;
  timeoutMs?: number;
}
type Input = { args: readonly string[]; stdin?: string; expectedOperation?: RoutineCliOperation; signal?: AbortSignal };
type Reason = Parameters<FixedNativeRoutineCliDependencies["cancel"]>[0]["reason"];
const failure = (code: keyof typeof ROUTINE_CLI_SAFE_ERRORS): RoutineCliEnvelope => ({ v: 1, error: { code, message: ROUTINE_CLI_SAFE_ERRORS[code] } });
const mutating = (op: RoutineCliOperation | undefined): op is Extract<RoutineCliOperation, { requestId: string }> => !!op && ["propose", "pause", "resume", "archive"].includes(op.operation);
function frozen<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
/** Fixed published Node CLI only. Host closures own source identity and issuance; child argv/body never do.
 * JSON IPC reduces accidental disclosure, not arbitrary same-UID process inspection. No source producer is installed. */
export function createFixedNativeRoutineCliInvoker(deps: FixedNativeRoutineCliDependencies) {
  const endpoint = RoutineCliEndpointSchema.parse(deps.endpoint);
  if (!isAbsolute(deps.binPath) || basename(deps.binPath) !== "matrix.mjs" || !statSync(deps.binPath).isFile()
    || typeof deps.authorize !== "function" || typeof deps.issue !== "function" || typeof deps.cancel !== "function") throw new Error("Routine CLI dependencies unavailable");
  const cwd = deps.cwd ?? process.cwd();
  if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error("Routine CLI working directory unavailable");
  const homePath = deps.homePath ?? process.env.HOME;
  if (homePath !== undefined && !isAbsolute(homePath)) throw new Error("Routine CLI home directory unavailable");
  const binPath = deps.binPath, authorize = deps.authorize, issue = deps.issue, cancel = deps.cancel;
  const timeoutMs = deps.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error("Routine CLI timeout invalid");
  let closed = false;
  const active = new Set<{ stop(reason: Reason): void; done: Promise<RoutineCliEnvelope> }>(); // Max8, per-child timeout, exit cleanup and explicit close drain.
  const invoke = (input: Input): Promise<RoutineCliEnvelope> => {
    if (closed || active.size >= 8) return Promise.resolve(failure("unavailable"));
    if (!Array.isArray(input.args) || input.args.length > 12 || input.args.some(arg => typeof arg !== "string" || arg.length > 2048)
      || typeof input.stdin !== "undefined" && (typeof input.stdin !== "string" || Buffer.byteLength(input.stdin) > ROUTINE_CLI_INPUT_BYTES)) return Promise.resolve(failure("invalid_input"));
    const expected = input.expectedOperation === undefined ? undefined : RoutineCliOperationSchema.safeParse(input.expectedOperation);
    if (expected && !expected.success) return Promise.resolve(failure("invalid_input"));
    let operation = expected?.success ? frozen(expected.data) : undefined;
    if (input.signal?.aborted) return Promise.resolve(mutating(operation) ? { v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } } : failure("unavailable"));
    const invocationId = randomUUID(), controller = new AbortController();
    let stop!: (reason: Reason) => void;
    const done = new Promise<RoutineCliEnvelope>(resolve => {
      let reason: Reason = "finished", stopping = false, finished = false, capabilitySent = false, requests = 0, stdoutBytes = 0, stderrBytes = 0;
      const stdout: Buffer[] = [];
      const args = input.args.includes("--json") ? input.args : [...input.args, "--json"];
      const child = spawn(process.execPath, [binPath, "routines", ...args], { cwd, stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json",
        env: { PATH: process.env.PATH, HOME: homePath, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ, MATRIX_NO_TELEMETRY: "1" } });
      let termTimer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = setTimeout(() => stop("timeout"), timeoutMs);
      const aborted = () => stop("aborted"); input.signal?.addEventListener("abort", aborted, { once: true });
      const fallback = (): RoutineCliEnvelope => mutating(operation) ? { v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } } : failure("unavailable");
      stop = why => {
        if (stopping || finished) return; stopping = true; reason = why; controller.abort();
        if (child.connected) child.send({ v: 1, type: "routine.cancel" }, error => { if (error && child.exitCode === null) child.kill("SIGTERM"); });
        termTimer = setTimeout(() => child.kill("SIGTERM"), 250);
        // Published relay first drains/kills its parser; allow that bounded two-second drain before wrapper kill.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
      };
      const finish = async (code: number | null) => {
        if (finished) return; finished = true; controller.abort(); clearTimeout(deadline); clearTimeout(termTimer); clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", aborted); child.removeAllListeners("message");
        let result = fallback();
        if (!stopping && stdoutBytes <= ROUTINE_CLI_OUTPUT_BYTES) {
          try {
            const parsed = RoutineCliEnvelopeSchema.safeParse(JSON.parse(Buffer.concat(stdout).toString("utf8")));
            if (parsed.success && code !== null && (!("ok" in parsed.data) || operation && routineCliResultMatchesOperation(operation, parsed.data.data)
              && (capabilitySent || parsed.data.data.kind === "unknown"))) result = parsed.data;
          } catch (error: unknown) { if (!(error instanceof SyntaxError)) console.warn("[routine-cli-invoker] Output unavailable", error instanceof Error ? error.name : "UnknownError"); }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([cancel({ operation, invocationId, reason }), new Promise<void>(complete => { timer = setTimeout(complete, 1000); })]); }
        catch (error: unknown) { console.warn("[routine-cli-invoker] Invocation cleanup unconfirmed", error instanceof Error ? error.name : "UnknownError"); }
        finally { clearTimeout(timer); }
        resolve(result);
      };
      const message = async (value: unknown, handle?: unknown) => {
        if (finished || stopping) return;
        let encoded: string;
        try { encoded = JSON.stringify(value); } catch (error: unknown) {
          console.warn("[routine-cli-invoker] Frame invalid", error instanceof Error ? error.name : "UnknownError"); stop("protocol_error"); return;
        }
        if (handle || !encoded || Buffer.byteLength(encoded) > ROUTINE_CLI_FRAME_BYTES || ++requests !== 1) { stop("protocol_error"); return; }
        const parsed = RoutineCliChildFrameSchema.safeParse(value);
        if (!parsed.success || expected?.success && JSON.stringify(expected.data) !== JSON.stringify(parsed.data.operation)) { stop("protocol_error"); return; }
        operation = frozen(parsed.data.operation);
        const request = Object.freeze({ operation, invocationId, signal: controller.signal });
        try {
          const allowed = await authorize(request);
          if (finished || stopping || controller.signal.aborted || !child.connected) return;
          if (allowed !== true) { child.send({ v: 1, type: "routine.denied", code: "permission_denied" }); return; }
          const delivery = await issue(request);
          if (finished || stopping || controller.signal.aborted || !child.connected) return;
          const token = RoutineCliTokenSchema.parse(delivery.takeToken());
          capabilitySent = true;
          child.send({ v: 1, type: "routine.capability", endpoint, token }, error => { if (error) stop("protocol_error"); });
        } catch (error: unknown) {
          if (finished || stopping || !child.connected) return;
          const parsed = RoutineCliErrorCodeSchema.safeParse(error && typeof error === "object" && "code" in error ? error.code : undefined);
          child.send({ v: 1, type: "routine.denied", code: parsed.success ? parsed.data : "unavailable" }, sendError => { if (sendError) stop("protocol_error"); });
        }
      };
      child.on("message", (value, handle) => { void message(value, handle).catch((error: unknown) => { console.warn("[routine-cli-invoker] Protocol unavailable", error instanceof Error ? error.name : "UnknownError"); stop("protocol_error"); }); });
      child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > ROUTINE_CLI_OUTPUT_BYTES) stop("protocol_error"); else stdout.push(chunk); });
      child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) stop("protocol_error"); });
      child.once("error", () => { void finish(null); }); child.once("close", code => { void finish(code); });
      child.stdin!.on("error", error => { if (!("code" in error) || error.code !== "EPIPE") stop("protocol_error"); });
      child.stdin!.end(input.stdin ?? "");
    });
    const entry = { stop: (reason: Reason) => stop(reason), done }; active.add(entry);
    void done.finally(() => active.delete(entry));
    return done;
  };
  return { invoke, async close() { closed = true; const entries = [...active]; for (const entry of entries) entry.stop("shutdown"); await Promise.allSettled(entries.map(entry => entry.done)); } };
}
