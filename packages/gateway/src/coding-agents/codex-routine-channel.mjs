import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { routineUnknownResult, RoutineArgvSchema, ManagedHostFrameSchema, ManagedShimFrameSchema, parseManagedFrame } from "./managed-launch-protocol.mjs";
const ref = z.string().min(1).max(512), rpcId = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const callSchema = z.object({ id: rpcId, method: z.literal("item/tool/call"), params: z.object({
  threadId: ref, turnId: ref, callId: ref, tool: z.literal("matrix_routines"), namespace: z.null().optional(), arguments: RoutineArgvSchema,
}).strict() }).passthrough();
// Standalone native resource. Match the read transport and native mutation limits in routine-cli-ipc.ts.
const READ_TRANSPORT_TIMEOUT_MS = 50_000;
const NATIVE_MUTATION_TIMEOUT_MS = 1_830_000;
const unavailable = JSON.stringify({ v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
export const CODEX_ROUTINE_TOOL = Object.freeze({ type: "function", name: "matrix_routines", deferLoading: false,
  description: "Run the fixed Matrix routines CLI. Mutations require a request UUID. For a queued proposal, use request with that UUID while this turn is live to observe pending approval. Reconcile unknown outcomes by the same UUID and never retry a mutation automatically. Activation and background permission remain separate owner decisions.",
  inputSchema: { type: "object", additionalProperties: false, required: ["args"], properties: {
    args: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 2048 } },
    stdin: { type: "string", maxLength: 32768 },
  } },
});
/** Private parent IPC only. Public stdin/control/native fields cannot attach a source. Never awaits CLI/owner work in the native frame consumer. */
export function createCodexRoutineChannel(options) {
  const parent = options.parent ?? process, shim = randomUUID();
  let enabled = !!options.enabled && parent.connected === true, ready = false, closed = false, binding, initialSettled = false;
  let initialResolve;
  const initialPromise = new Promise(resolve => { initialResolve = resolve; });
  const turns = new Map(), admissions = new Set(), calls = new Map(); // queued20, admissions128 ring, calls128 per turn; explicit end/disconnect drain.
  const turnSources = new WeakMap();
  function send(frame) {
    if (!enabled || closed || !parent.connected || !parseManagedFrame(ManagedShimFrameSchema, frame)) return false;
    parent.send(frame, error => { if (error) disconnect(); }); return true;
  }
  function result(id, text) {
    let success = false;
    try { const body = JSON.parse(text); success = body.v === 1 && body.ok === true && body.data?.kind !== "unknown"; }
    catch (error) { if (!(error instanceof SyntaxError)) console.warn("[codex-routines] Result unavailable", error instanceof Error ? error.name : "UnknownError"); text = unavailable; }
    try { options.sendNative({ id, result: { contentItems: [{ type: "inputText", text }], success } }); }
    catch (error) { console.warn("[codex-routines] Delivery unavailable", error instanceof Error ? error.name : "UnknownError"); }
  }
  function ownerWait(entry, waiting) {
    if (waiting ? entry.ownerWaiting !== undefined : entry.ownerWaiting !== true) return;
    entry.ownerWaiting = waiting;
    options.ownerWaitChanged?.(entry.callId, entry.binding.turnId, waiting);
  }
  function complete(entry, text) {
    if (entry.done) return; entry.done = true; clearTimeout(entry.timer); entry.text = text;
    ownerWait(entry, false);
    if (binding === entry.binding && options.current(entry.binding)) for (const id of entry.ids) result(id, text);
    entry.ids.length = 0;
  }
  function end() {
    const prior = binding; binding = undefined;
    if (prior) send({ type: "shim.end", admissionId: prior.admissionId });
    for (const entry of calls.values()) {
      // Release the original native request without retaining authority or borrowing a later turn.
      if (!entry.done && prior === entry.binding && options.current(entry.binding)) for (const id of entry.ids) result(id, routineUnknownResult(entry.intent));
      ownerWait(entry, false);
      clearTimeout(entry.timer); entry.done = true; entry.ids.length = 0;
    }
    calls.clear();
  }
  function disconnect() {
    if (closed) return; end(); closed = true; enabled = false;
    for (const [admissionId, turn] of turns) { turnSources.delete(turn); send({ type: "shim.end", admissionId }); }
    turns.clear(); admissions.clear(); parent.off("message", message); parent.off("disconnect", disconnect);
    if (!initialSettled) { initialSettled = true; initialResolve(undefined); }
  }
  function message(raw, handle) {
    const frame = parseManagedFrame(ManagedHostFrameSchema, raw);
    if (closed) return;
    if (handle || !frame) { disconnect(); return; }
    if (frame.type === "host.disconnect") { disconnect(); return; }
    if (frame.type === "host.ready") { if (ready || frame.shim !== shim) disconnect(); else ready = true; return; }
    if (!ready) { disconnect(); return; }
    if (frame.type === "host.turn") {
      if (admissions.has(frame.admissionId) || turns.size >= 20 || frame.first && initialSettled) { send({ type: "shim.end", admissionId: frame.admissionId }); return; }
      if (admissions.size >= 128) admissions.delete(admissions.values().next().value);
      const turn = frame.turn ?? options.initialTurn();
      admissions.add(frame.admissionId); turns.set(frame.admissionId, turn); turnSources.set(turn, frame.admissionId);
      if (frame.first) { initialSettled = true; initialResolve(turn); }
      else if (!options.enqueue(turn, frame.clientRequestId)) { turns.delete(frame.admissionId); turnSources.delete(turn); send({ type: "shim.end", admissionId: frame.admissionId }); return; }
      send({ type: "shim.accepted", admissionId: frame.admissionId });
    } else if (frame.type === "host.cancel") {
      if (binding?.admissionId === frame.admissionId) end();
      const turn = turns.get(frame.admissionId); if (turn) { turns.delete(frame.admissionId); turnSources.delete(turn); send({ type: "shim.end", admissionId: frame.admissionId }); }
    } else if (frame.type === "host.result" || frame.type === "host.owner_wait") {
      const entry = calls.get(frame.actionId);
      if (!entry || entry.done || entry.binding.admissionId !== frame.admissionId || binding !== entry.binding || !options.current(entry.binding)) return;
      if (frame.type === "host.result") complete(entry, frame.result);
      else if (entry.mutation) ownerWait(entry, frame.waiting);
    }
  }
  if (enabled) { parent.on("message", message); parent.on("disconnect", disconnect); send({ type: "shim.ready", shim }); }
  return {
    async initial(signal) {
      if (!enabled) return undefined;
      let timer;
      const abort = () => { if (!initialSettled) { initialSettled = true; initialResolve(undefined); } };
      try { timer = setTimeout(abort, 10_000); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); return await initialPromise; }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    },
    canRegister: () => enabled && ready && initialSettled && turns.size > 0,
    isWaitingForOwner: (callId, turnId) => binding?.turnId === turnId && [...calls.values()].some(entry => entry.callId === callId && entry.ownerWaiting === true),
    bind(turn, nativeGeneration, threadId, turnId, featureThread) {
      end(); const admissionId = turnSources.get(turn); turnSources.delete(turn);
      if (admissionId) turns.delete(admissionId);
      if (!admissionId || !enabled || !featureThread) { if (admissionId) send({ type: "shim.end", admissionId }); return; }
      binding = Object.freeze({ admissionId, nativeGeneration, threadId, turnId });
      send({ type: "shim.bound", ...binding });
    },
    handle(raw) {
      if (raw?.method !== "item/tool/call") return false;
      if (!rpcId.safeParse(raw.id).success) return true;
      const parsed = callSchema.safeParse(raw);
      if (!parsed.success || !binding || !enabled || !options.current(binding) || parsed.data.params.threadId !== binding.threadId || parsed.data.params.turnId !== binding.turnId) { result(raw.id, unavailable); return true; }
      const { params } = parsed.data, fingerprint = JSON.stringify(params);
      const duplicate = [...calls.values()].find(entry => entry.callId === params.callId);
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint || duplicate.ids.length >= 2) result(raw.id, unavailable);
        else if (duplicate.done) result(raw.id, duplicate.text);
        else duplicate.ids.push(raw.id);
        return true;
      }
      if (calls.size >= 128 || [...calls.values()].filter(entry => !entry.done).length >= 8) { result(raw.id, unavailable); return true; }
      const mutation = ["propose", "pause", "resume", "archive"].includes(params.arguments.args[0]);
      const actionId = randomUUID(), entry = { binding, callId: params.callId, fingerprint, intent: params.arguments, ids: [raw.id], mutation, done: false };
      calls.set(actionId, entry); entry.timer = setTimeout(() => { send({ type: "shim.cancel", admissionId: entry.binding.admissionId, actionId }); complete(entry, routineUnknownResult(entry.intent)); }, mutation ? NATIVE_MUTATION_TIMEOUT_MS : READ_TRANSPORT_TIMEOUT_MS); entry.timer.unref();
      if (!send({ type: "shim.call", ...binding, callId: params.callId, actionId, intent: params.arguments })) complete(entry, routineUnknownResult(entry.intent));
      return true;
    },
    end, close: disconnect,
  };
}
