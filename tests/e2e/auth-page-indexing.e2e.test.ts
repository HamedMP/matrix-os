import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const shell = resolve(__dirname, "../../shell");
const nextEnvironment = resolve(shell, "next-env.d.ts");
const require = createRequire(resolve(shell, "package.json"));

/** Read served HTML attributes without depending on tag order or formatting. */
function headElements(html: string) {
  return [...html.matchAll(/<(?:meta|link)\b[^>]*>/gi)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(([, name, value]) => [name, value])),
  );
}

describe("Web Desktop account-page indexing over HTTP", () => {
  let processHandle: ChildProcess | undefined;
  let origin: string;
  let output = "";
  let originalNextEnvironment: Buffer | undefined;

  beforeAll(async () => {
    originalNextEnvironment = await readFile(nextEnvironment);
    const reservation = createServer();
    await new Promise<void>((done, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", done);
    });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const port = address.port;
    await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;

    processHandle = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: shell,
      env: {
        ...process.env,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        E2E_TEST_BYPASS: "1",
        NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_bWF0cml4b3MudGVzdCQ=",
        CLERK_SECRET_KEY: "sk_test_auth_indexing_fixture",
        GATEWAY_URL: "",
        NEXT_PUBLIC_GATEWAY_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-32_768); };
    processHandle.stdout?.on("data", capture);
    processHandle.stderr?.on("data", capture);

    const deadline = Date.now() + 110_000;
    // Compile every tested route during setup; cold Next compilation is not an
    // assertion about the response time of an already-running production page.
    for (const route of ["sign-in", "sign-up", "runtime"]) {
      let ready = false;
      while (Date.now() < deadline) {
        if (processHandle.exitCode !== null) throw new Error(`Auth test server exited: ${output}`);
        try {
          const response = await fetch(`${origin}/${route}`, { signal: AbortSignal.timeout(10_000) });
          if (response.ok) {
            await response.text();
            ready = true;
            break;
          }
          if (response.status >= 500) throw new Error(`Auth test server returned ${response.status}: ${output}`);
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "TimeoutError")) throw error;
        }
        await delay(250);
      }
      if (!ready) throw new Error(`Auth test route ${route} did not become ready: ${output}`);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      const child = processHandle;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const deadline = Date.now() + 10_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          const killDeadline = Date.now() + 2_000;
          while (child.exitCode === null && child.signalCode === null && Date.now() < killDeadline) await delay(50);
          if (child.exitCode === null && child.signalCode === null) throw new Error("Auth test server did not stop");
        }
      }
    } finally {
      // Next dev rewrites this tracked file; preserve the caller's exact bytes so
      // subsequent release builds can still verify a clean source checkout.
      if (originalNextEnvironment) await writeFile(nextEnvironment, originalNextEnvironment);
    }
  }, 15_000);

  for (const route of ["sign-in", "sign-up", "runtime"]) {
    for (const query of ["", "?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2Frecipes%2Fevent-request-desk&promo=launch"]) {
      it(`${route}${query ? " query variant" : " base URL"} serves noindex and a stable canonical`, async () => {
        const response = await fetch(`${origin}/${route}${query}`, { signal: AbortSignal.timeout(20_000) });
        expect(response.status).toBe(200);
        const elements = headElements(await response.text());
        const robots = elements.find((element) => element.name === "robots")?.content.split(",").map((value) => value.trim());
        expect(robots).toEqual(expect.arrayContaining(["noindex", "follow"]));
        expect(elements.find((element) => element.rel === "canonical")?.href).toBe(`https://app.matrix-os.com/${route}`);
      });
    }
  }
});
