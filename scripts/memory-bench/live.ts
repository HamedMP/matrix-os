import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LiveBenchmarkCasesSchema,
  scoreLiveComparison,
  type LiveResult,
} from "./live-comparison.js";
import { z } from "zod/v4";
const response = z
  .object({
    query: z.string().max(2000),
    results: z
      .array(
        z
          .object({
            engine: z.enum(["hindsight", "openviking"]),
            status: z.enum(["ready", "unavailable", "not_configured"]),
            latencyMs: z.number().nonnegative(),
            hits: z
              .array(z.object({ sourceId: z.string().min(1).max(128) }))
              .max(20),
          }),
      )
      .max(2),
  })
  .strict();
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** Private score audit contains ranked identifiers, status and timing; source bodies/debug fields are excluded. */
export function buildLiveReport(inputLabels: unknown, inputObservations: unknown) {
  const labels = LiveBenchmarkCasesSchema.parse(inputLabels);
  const observations = z.array(response).max(200).parse(inputObservations);
  if (observations.length !== labels.length) throw Error("Comparison observation count does not match labels");
  const report = {
    version: 2,
    createdAt: new Date().toISOString(),
    metrics: scoreLiveComparison(labels, observations),
    labels,
    observations,
  };
  if (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_REPORT_BYTES) throw Error("Live report exceeds limit");
  return report;
}
async function readComparisonResponse(res: Response): Promise<unknown> {
  if (!res.body) throw Error("Comparison response missing");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) throw Error("Comparison response exceeds limit");
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1)
    throw Error("Pass a reviewed benchmark-cases.json file");
  const endpoint = new URL(
    process.env.MATRIX_MEMORY_BENCH_URL ?? "http://127.0.0.1:4000",
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(endpoint.hostname))
    )
  )
    throw Error("Use HTTPS or local gateway");
  const token = process.env.MATRIX_MEMORY_BENCH_TOKEN;
  if (!token) throw Error("Authenticated gateway token required");
  const file = resolve(args[0]);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw Error("Cases exceed file limit");
  const cases = LiveBenchmarkCasesSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  const results: LiveResult[] = [];
  for (const test of cases) {
    const res = await fetch(
      new URL(
        "api/memory-workspace/compare",
        endpoint.href.endsWith("/") ? endpoint : new URL(endpoint.href + "/"),
      ),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: test.query, limit: 8 }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      },
    );
    if (!res.ok) throw Error("Comparison request failed");
    results.push(response.parse(await readComparisonResponse(res)));
  }
  const report = buildLiveReport(cases, results);
  const out = join(resolve("output/memory-bench"), `live-${randomUUID()}`);
  await mkdir(out, { recursive: true, mode: 0o700 });
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify(report.metrics, null, 2));
  console.log(`Report: ${join(out, "results.json")}`);
  return Object.values(report.metrics).every(
    (result) => result.availability === 1,
  )
    ? 0
    : 2;
}
if (import.meta.main)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        `Live benchmark failed (${error instanceof Error ? error.name : "Error"}). Check cases, authentication and engine readiness.`,
      );
      process.exitCode = 1;
    });
