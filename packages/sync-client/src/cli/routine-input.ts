import { BotRoutineProposalSchema, RoutineCliOperationSchema, ROUTINE_CLI_INPUT_BYTES, type RoutineCliOperation } from "@matrix-os/contracts/routine-cli";
import { RoutineClientError } from "./routine-client.js";
const invalid = () => new RoutineClientError("invalid_input");
/** Citty parses values. This bounded guard rejects aliases/duplicates/extra syntax its permissive parser accepts. */
export function validateRoutineArgv(raw: readonly string[], parsed: Record<string, unknown>) {
  if (raw.length > 12 || raw.some(value => value.length > 2048)) throw invalid();
  const seen = new Set<string>(), operands: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (!arg.startsWith("-")) { operands.push(arg); continue; }
    const equal = arg.indexOf("="), flag = equal < 0 ? arg : arg.slice(0, equal);
    if (!["--json", "--input", "--request-id", "--revision"].includes(flag) || seen.has(flag)) throw invalid();
    seen.add(flag);
    if (flag === "--json") { if (equal >= 0) throw invalid(); continue; }
    const value = equal < 0 ? raw[++i] : arg.slice(equal + 1);
    if (!value || value.startsWith("--") || value.length > 2048) throw invalid();
  }
  const verb = operands[0], allowed = verb === "propose" ? ["--json", "--input", "--request-id"]
    : ["pause", "resume", "archive"].includes(verb ?? "") ? ["--json", "--request-id", "--revision"] : ["--json"];
  if ([...seen].some(flag => !allowed.includes(flag)) || operands.length !== (["show", "request", "pause", "resume", "archive"].includes(verb ?? "") ? 2 : 1)
    || parsed.verb !== verb || parsed.operand !== operands[1]) throw invalid();
  if (!["list", "show", "request", "propose", "pause", "resume", "archive"].includes(verb ?? "")) throw invalid();
  if (verb === "propose" && parsed.input !== "-") throw invalid();
}
function boundedJson(text: string): unknown {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { if (++depth > 16) throw invalid(); }
    else if (char === "}" || char === "]") depth--;
  }
  return JSON.parse(text);
}
export async function readRoutineProposal() {
  if (process.stdin.isTTY) throw invalid();
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); process.stdin.removeListener("data", data); process.stdin.removeListener("end", end); process.stdin.removeListener("error", error); process.stdin.pause(); };
    const error = () => { cleanup(); reject(invalid()); };
    const data = (chunk: Buffer | string) => { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
      if (bytes > ROUTINE_CLI_INPUT_BYTES) { error(); return; } if (buffer.length) chunks.push(buffer); };
    const end = () => {
      cleanup();
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch (failure: unknown) { if (!(failure instanceof TypeError)) console.warn("[routine-cli] Input unavailable", failure instanceof Error ? failure.name : "UnknownError"); reject(invalid()); }
    };
    const timer = setTimeout(error, 5000);
    process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", error); process.stdin.resume();
  });
  return BotRoutineProposalSchema.parse(boundedJson(text));
}
export async function routineOperationFromCitty(raw: readonly string[], args: Record<string, unknown>): Promise<RoutineCliOperation> {
  validateRoutineArgv(raw, args);
  const operation = String(args.verb);
  if (operation === "list") return RoutineCliOperationSchema.parse({ operation });
  if (operation === "show") return RoutineCliOperationSchema.parse({ operation, routineId: args.operand });
  if (operation === "request") return RoutineCliOperationSchema.parse({ operation, requestId: args.operand });
  if (operation === "propose") return RoutineCliOperationSchema.parse({ operation, requestId: args["request-id"], proposal: await readRoutineProposal() });
  if (typeof args.revision !== "string" || !/^[1-9]\d{0,15}$/.test(args.revision)) throw invalid();
  return RoutineCliOperationSchema.parse({ operation, routineId: args.operand, baseRevision: Number(args.revision), requestId: args["request-id"] });
}
