import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod/v4";
import { cliError, formatCliSuccess } from "../output.js";

const revision = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const log = z.string().min(1).max(4096).refine(text => !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(text));
const receiptSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("update"), revision }),
  z.strictObject({ type: z.literal("test"), revision, exitCode: z.number().int().min(0).max(255), log }),
  z.strictObject({ type: z.literal("stopped") }),
]);
type Receipt = z.infer<typeof receiptSchema>;
const MAX_LINE_BYTES = 20 * 1024;
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 45_000;

async function* readReceipts(stdout: Readable): AsyncGenerator<Receipt> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  for await (const chunk of stdout as AsyncIterable<Buffer>) {
    const buffer = Buffer.concat([pending, chunk]);
    let start = 0;
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      if (end - start > MAX_LINE_BYTES) throw new Error("Oversized watch receipt");
      yield receiptSchema.parse(JSON.parse(decoder.decode(buffer.subarray(start, end))));
      start = end + 1;
    }
    pending = buffer.subarray(start);
    if (pending.length > MAX_LINE_BYTES) throw new Error("Oversized watch receipt");
  }
  if (pending.length) throw new Error("Incomplete watch receipt");
}

function printReceipt(receipt: Receipt, computer: string, worktree: string, json: boolean): void {
  if (json) {
    console.log(formatCliSuccess({ computer, worktree, ...receipt }));
    return;
  }
  switch (receipt.type) {
    case "ready": console.log(`Stage 3 watching ${computer}/${worktree}`); break;
    case "update": console.log(`Synced revision ${receipt.revision}`); break;
    case "test": console.log(`Revision ${receipt.revision} test exit ${receipt.exitCode}: ${receipt.log}`); break;
    case "stopped": console.log("Stage 3 watch stopped"); break;
  }
}

export async function watchStageThree(adapter: string, computer: string, worktree: string, json: boolean): Promise<void> {
  const child = spawn(adapter, ["watch", computer, worktree], { stdio: ["ignore", "pipe", "ignore"] });
  let failed = false;
  child.once("error", () => { failed = true; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  let stopTimer: NodeJS.Timeout | undefined;
  function allowCleanup() {
    stopTimer ??= setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
    }, STOP_TIMEOUT_MS);
  }
  function stop() {
    if (stopTimer) return;
    allowCleanup();
    child.kill("SIGTERM");
  }
  const startTimer = setTimeout(() => { failed = true; stop(); }, START_TIMEOUT_MS);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let state: "starting" | "ready" | "stopped" = "starting";
  let pending: string | undefined;
  try {
    for await (const receipt of readReceipts(child.stdout)) {
      if (receipt.type === "ready" && state === "starting") {
        state = "ready";
        clearTimeout(startTimer);
      } else if (receipt.type === "update" && state === "ready" && pending === undefined) {
        pending = receipt.revision;
      } else if (receipt.type === "test" && state === "ready" && pending === receipt.revision) {
        pending = undefined;
      } else if (receipt.type === "stopped" && state === "ready" && (pending === undefined || stopTimer)) {
        state = "stopped";
        allowCleanup();
      } else {
        throw new Error("Unexpected watch receipt");
      }
      printReceipt(receipt, computer, worktree, json);
    }
  } catch (error: unknown) {
    failed = true;
    stop();
    if (!(error instanceof Error)) throw error;
  } finally {
    if (state !== "stopped") stop();
    if (await closed !== 0) failed = true;
    clearTimeout(startTimer);
    clearTimeout(stopTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (failed || state !== "stopped") {
    throw cliError("devstack_watch_failed", "Stage 3 watch did not finish cleanly. Check the enrolled adapter.");
  }
}
