import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function actualBin(args: string[], input: string | Buffer = "") {
  const home = await mkdtemp(join(tmpdir(), "routine-cli-bin-")); homes.push(home);
  await mkdir(join(home, ".matrixos")); await writeFile(join(home, ".matrixos", "auth.json"), JSON.stringify({ accessToken: "fixture-owner-profile-token" }));
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((done, reject) => {
    const child = execFile(process.execPath, [resolve("packages/sync-client/bin/matrix.mjs"), ...args], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, MATRIX_AUTH_TOKEN: "fixture-owner-environment-token", MATRIX_NO_TELEMETRY: "1" }, timeout: 10000, maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      if (error && !("code" in error && typeof error.code === "number")) { reject(error); return; }
      done({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
    }); child.stdin!.end(input);
  });
}
it("actual published citty routines command requires host source despite a saved profile/environment owner token", async () => {
  const result = await actualBin(["routines", "list", "--json"]);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ v: 1, error: { code: "source_context_required", message: "An authorized Matrix source context is required." } });
  expect(result.stderr).not.toContain("fixture-owner");
});
it.each([
  { name: "list", argv: ["list"], operation: { operation: "list" }, result: { kind: "list", routines: [], truncated: false } },
  { name: "approved receipt with unavailable current routine link", argv: ["request", "de000000-0000-4000-8000-000000000100"],
    operation: { operation: "request", requestId: "de000000-0000-4000-8000-000000000100" },
    result: { kind: "receipt", receipt: { requestId: "de000000-0000-4000-8000-000000000100", operation: "propose", disposition: "queued", revision: 1, createdAt: "2026-09-27T12:00:00.000Z" },
      current: null, approval: null, proposal: { handoff: "pending_approval", revision: 5, approval: "approved", routine: null, routineLink: "unavailable" } } },
])("actual published bin relays $name privately and child alone performs the scoped HTTP request", async ({ argv, operation, result }) => {
  const { createServer } = await import("node:http"), { fork } = await import("node:child_process");
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ v: 1, ok: true, data: result }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`;
  const home = await mkdtemp(join(tmpdir(), "routine-cli-ipc-")); homes.push(home);
  const child = fork(resolve("packages/sync-client/bin/matrix.mjs"), ["routines", ...argv, "--json"], { cwd: home, execArgv: [], silent: true,
    env: { PATH: process.env.PATH, HOME: home, MATRIX_NO_TELEMETRY: "1" } });
  let stdout = "", stderr = "", requests = 0;
  child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; }); child.stdin!.end();
  child.on("message", frame => { expect(frame).toEqual({ v: 1, type: "routine.request", operation }); requests++;
    child.send({ v: 1, type: "routine.capability", endpoint, token: "rcli_" + "A".repeat(43) }); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", code => done(code)); });
    expect(requests).toBe(1); expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ v: 1, ok: true, data: result });
    expect(received).toEqual([{ authorization: "RoutineCapability rcli_" + "A".repeat(43), body: { operation } }]);
    expect(stdout + stderr).not.toContain("rcli_");
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await new Promise<void>(done => server.close(() => done())); }
});
const REQUEST = "de000000-0000-4000-8000-000000000100", ROUTINE = "rt_" + "a".repeat(24);
const PROPOSAL = { name: "Daily report", prompt: "Read fixtures", schedule: { kind: "interval", everyMs: 60000 },
  selection: { instanceId: "matrix_chatgpt_plan", model: "fixture-model" }, authorizedEffects: ["read"] };
it.each(["owner", "computer", "chat", "bot", "run", "grant", "account", "token", "profile", "gateway", "source", "invocation-id", "runtime", "harness"])("actual parser rejects identity override --%s", async flag => {
  const result = await actualBin(["routines", "list", `--${flag}`, "private-override", "--json"]);
  expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
  expect(result.stdout + result.stderr).not.toContain("private-override");
});
it.each([
  ["list", "extra"], ["list", "--json", "--json"], ["list", "--json=false"], ["list", "--no-json"], ["list", "--whatever"],
  ["show", ROUTINE, "extra"], ["request", REQUEST, "--revision", "1"], ["pause", ROUTINE, "--revision", "1"],
  ["pause", ROUTINE, "--revision", "-1", "--request-id", REQUEST], ["pause", ROUTINE, "--revision", "1e3", "--request-id", REQUEST],
  ["pause", ROUTINE, "--revision", "9007199254740992", "--request-id", REQUEST],
  ["pause", ROUTINE, "--revision", "1", "--revision", "2", "--request-id", REQUEST],
  ["pause", ROUTINE, "--revision", "1", "--requestId", REQUEST], ["propose", "--input", "some-file", "--request-id", REQUEST],
].map(argv => ({ argv })))("actual parser rejects invalid/repeated/extra syntax $argv", async ({ argv }) => {
  const result = await actualBin(["routines", ...argv, "--json"]);
  expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
});
it.each(["ownerId", "chatId", "botId", "runId", "accountId", "grantRevision", "token"])("strict proposal stdin rejects body identity %s", async key => {
  const result = await actualBin(["routines", "propose", "--input", "-", "--request-id", REQUEST, "--json"], JSON.stringify({ ...PROPOSAL, [key]: "private-identity" }));
  expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe("invalid_input"); expect(result.stdout).not.toContain("private-identity");
});
it("legitimate A model/effect selectors are intent, accepted without fabricating a default or supplying authority", async () => {
  const result = await actualBin(["routines", "propose", "--input", "-", "--request-id", REQUEST, "--json"], JSON.stringify(PROPOSAL));
  expect(JSON.parse(result.stdout).error.code).toBe("source_context_required");
});
it.each([JSON.stringify(PROPOSAL) + "\n{}", JSON.stringify(PROPOSAL) + "junk", "[".repeat(20) + "]".repeat(20), " ".repeat(24577), JSON.stringify({ ...PROPOSAL, prompt: "\u0000".repeat(3500) })])("stdin enforces single JSON, depth, bytes and A escaped proposal budget", async body => {
  const result = await actualBin(["routines", "propose", "--input", "-", "--request-id", REQUEST, "--json"], body);
  expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
});
it.each(["bash", "zsh", "fish"])("actual completion %s includes all routines verbs and redirect stays published", async shell => {
  const result = await actualBin(["completion", shell]);
  expect(result.code).toBe(0); expect(result.stdout).toContain("routines");
  for (const verb of ["list", "show", "request", "propose", "pause", "resume", "archive"]) expect(result.stdout).toContain(verb);
  const { resolvePublishedCliRedirect } = await import("../../packages/cli/src/index.js");
  expect(resolvePublishedCliRedirect(["routines", "list", "--json"])).toEqual(["routines", "list", "--json"]);
});

it("actual proposal stdin rejects invalid UTF-8 rather than authorizing replacement text", async () => {
  const body = Buffer.concat([Buffer.from(JSON.stringify(PROPOSAL).replace("Daily report", "BYTE_MARKER").split("BYTE_MARKER")[0]!),
    Buffer.from([0xc3, 0x28]), Buffer.from(JSON.stringify(PROPOSAL).replace("Daily report", "BYTE_MARKER").split("BYTE_MARKER")[1]!)]);
  const result = await actualBin(["routines", "propose", "--input", "-", "--request-id", REQUEST, "--json"], body);
  expect(result.code).toBe(2); expect(JSON.parse(result.stdout)).toHaveProperty("error.code", "invalid_input");
});
