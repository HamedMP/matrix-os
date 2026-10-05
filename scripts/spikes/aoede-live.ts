/** Explicit, bounded real-provider transport check. No microphone, Matrix
 * effects, stored audio, transcript logging, or subjective quality claims.
 * Run with AOEDE_SPIKE_ENV_FILE pointing to an operator-owned credential file.
 */
import { readFile } from "node:fs/promises";
import { createGeminiLiveClient } from "../../packages/gateway/src/onboarding/gemini-live.js";

const envFile = process.env.AOEDE_SPIKE_ENV_FILE;
const raw = envFile ? await readFile(envFile, "utf8") : "";
const entry = raw.split("\n").find(line => /^(?:GEMINI_API_KEY|GOOGLE_API_KEY)=/.test(line));
const key = process.env.GEMINI_API_KEY ?? entry?.slice(entry.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("An explicit operator-owned Gemini credential is required");
const model = process.env.AOEDE_SPIKE_MODEL ?? "gemini-3.8-live";
const pcm = process.env.AOEDE_SPIKE_PCM_FILE ? await readFile(process.env.AOEDE_SPIKE_PCM_FILE) : null;
if (pcm && (pcm.length === 0 || pcm.length > 960_000 || pcm.length % 2)) throw new Error("PCM input must be mono 16kHz, bounded to 30 seconds");
const client = createGeminiLiveClient(key, model, {
  voiceName: "Aoede", systemInstruction: "You are testing native voice transport. Follow instructions briefly. check_task is read-only. Never claim any Matrix effect occurred.",
  tools: [{ functionDeclarations: [{ name: "check_task", behavior: "NON_BLOCKING", description: "Read a transport fixture status; causes no effects.", parameters: { type: "OBJECT", properties: {} } }] }],
});
const counts = { audioChunks: 0, audioWhileToolPending: 0, outputCaptionChunks: 0, inputCaptionChunks: 0, toolCalls: 0, completedTurns: 0, interruptions: 0, errors: 0 };
const toolTimers = new Set<ReturnType<typeof setTimeout>>(); // max three; cleared on exit
let stop!: () => void;
const finished = new Promise<void>(resolve => { stop = resolve; });
let attemptedInterruption = false;
client.on("audio", () => {
  counts.audioChunks++;
  if (toolTimers.size) counts.audioWhileToolPending++;
  if (counts.completedTurns === 1 && !attemptedInterruption) {
    attemptedInterruption = true;
    client.sendText("Stop. Please just say okay.");
  }
});
client.on("output_transcript", () => { counts.outputCaptionChunks++; });
client.on("input_transcript", () => { counts.inputCaptionChunks++; });
client.on("interrupted", () => { counts.interruptions++; });
client.on("tool_call", event => {
  const call = event as { id: string; name: string };
  counts.toolCalls++;
  if (call.name === "check_task" && toolTimers.size < 3) {
    const timer = setTimeout(() => {
      toolTimers.delete(timer);
      client.sendToolResponse(call.id, { state: "accepted", fixture: true, scheduling: "WHEN_IDLE" }, call.name);
    }, 2000);
    toolTimers.add(timer);
  }
});
client.on("turn_complete", () => {
  counts.completedTurns++;
  if (counts.completedTurns === 1) client.sendText("Verified fixture task update: state is running. Explain this update in two sentences. This is a fixture, no real task ran.");
  if (counts.completedTurns >= 3) stop();
});
client.on("error", () => { counts.errors++; stop(); });
client.on("disconnected", () => stop());
const deadline = setTimeout(stop, 30_000);
try {
  await client.connect();
  if (pcm) {
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      client.sendAudio(pcm.subarray(offset, offset + 3200).toString("base64"));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Native VAD needs a short silence tail to recognize the end of speech.
    for (let n = 0; n < 15; n++) { client.sendAudio(Buffer.alloc(3200).toString("base64")); await new Promise(resolve => setTimeout(resolve, 100)); }
  } else client.sendText("Call check_task once, then explain in one sentence that this is a transport test with no real task.");
  await finished;
  console.log(JSON.stringify({ model, voice: "Aoede", setup: "connected", ...counts, attemptedInterruption, audioInputTested: Boolean(pcm), microphoneTested: false, effectsTested: false }));
} catch (error: unknown) {
  console.log(JSON.stringify({ model, setup: "unavailable", errorType: error instanceof Error ? error.name : "UnknownError", ...counts }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); for (const timer of toolTimers) clearTimeout(timer); toolTimers.clear(); client.close(); }
