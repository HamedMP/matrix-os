import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { GithubDeveloperDeviceCodeSchema, type GithubDeveloperSetupOperation } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { githubOwnerEnvironment } from "./github-owner-environment.js";
import { isRequestPrincipalError, mapRequestPrincipalError } from "./request-principal.js";

const SETUP_PATH = "/api/github/setup";
const SETUP_DEADLINE_MS = 10 * 60_000;
const RESULT_RETENTION_MS = 60_000;
const TERMINATION_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 256;
const deviceEvent = z.object({ deviceCode: GithubDeveloperDeviceCodeSchema }).strict();
const operationId = z.uuid();
const emptyBody = z.object({}).strict();

type SetupChild = ChildProcessByStdio<null, Readable, null>;
type FinalState = "succeeded" | "failed" | "expired" | "cancelled";

interface Attempt {
  view: GithubDeveloperSetupOperation;
  abort: AbortController;
  stopped: Promise<false>;
  notifyStopped: (value: false) => void;
  child?: SetupChild;
  escalation?: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
}

function isActive(view: GithubDeveloperSetupOperation): boolean {
  return view.state === "starting" || view.state === "awaiting_authorization";
}

function signalGroup(child: SetupChild, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      console.warn("[github-setup] Could not signal setup process group:", error instanceof Error ? error.name : "UnknownError");
    }
  }
}

/** Own at most one process for this Computer and bind all observations to its owner. */
export function registerGithubDeveloperSetup(options: {
  app: Hono;
  homePath: string;
  ownerId: string | null;
  getPrincipal: (c: Context) => { userId: string } | null;
  canWrite: (signal: AbortSignal) => Promise<boolean>;
  checkReady: () => Promise<boolean>;
  spawnSetup?: () => SetupChild;
  timeoutMs?: number;
}): { close(): Promise<void> } {
  const routes = new Hono();
  const startChild = options.spawnSetup ?? (() => spawn("/opt/matrix/bin/matrix-github-developer-login", ["--settings"], {
    cwd: options.homePath,
    env: githubOwnerEnvironment(options.homePath),
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  }));
  let current: Attempt | undefined;
  let retained: { view: GithubDeveloperSetupOperation; expiresAt: number } | undefined;
  let closed = false;

  function stop(attempt: Attempt, state: FinalState): void {
    if (!isActive(attempt.view)) return;
    attempt.view = { id: attempt.view.id, state };
    attempt.notifyStopped(false);
    attempt.abort.abort();
    const child = attempt.child;
    if (!child) return;
    signalGroup(child, "SIGTERM");
    attempt.escalation = setTimeout(() => signalGroup(child, "SIGKILL"), TERMINATION_GRACE_MS);
    attempt.escalation.unref();
  }

  async function run(attempt: Attempt): Promise<void> {
    const timeout = setTimeout(() => stop(attempt, "expired"), options.timeoutMs ?? SETUP_DEADLINE_MS);
    timeout.unref();
    try {
      if (!await Promise.race([options.canWrite(attempt.abort.signal), attempt.stopped])) { stop(attempt, "failed"); return; }
      if (!isActive(attempt.view)) return;
      const child = startChild();
      attempt.child = child;
      let buffer = "";
      let eventSeen = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (!isActive(attempt.view)) return;
        if (eventSeen || Buffer.byteLength(buffer) + chunk.length > MAX_OUTPUT_BYTES) {
          stop(attempt, "failed");
          return;
        }
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          if (newline !== buffer.length - 1) throw new Error("unexpected setup output");
          const event = deviceEvent.parse(JSON.parse(buffer.slice(0, newline)));
          eventSeen = true;
          buffer = "";
          attempt.view = { id: attempt.view.id, state: "awaiting_authorization", deviceCode: event.deviceCode };
        } catch (error: unknown) {
          console.warn("[github-setup] Invalid setup event:", error instanceof Error ? error.name : "UnknownError");
          stop(attempt, "failed");
        }
      });
      const code = await new Promise<number | null>(resolve => {
        child.once("error", (error: Error) => {
          console.warn("[github-setup] Setup process unavailable:", error.name);
          stop(attempt, "failed");
        });
        child.once("close", resolve);
      });
      clearTimeout(attempt.escalation);
      attempt.child = undefined;
      if (!isActive(attempt.view)) return;
      if (code !== 0 || buffer.length > 0) { stop(attempt, "failed"); return; }
      attempt.view = { id: attempt.view.id, state: "starting" };
      const ready = await Promise.race([options.checkReady(), attempt.stopped]);
      stop(attempt, ready ? "succeeded" : "failed");
    } catch (error: unknown) {
      console.warn("[github-setup] Setup unavailable:", error instanceof Error ? error.name : "UnknownError");
      stop(attempt, "failed");
    } finally {
      clearTimeout(timeout);
      retained = { view: attempt.view, expiresAt: Date.now() + RESULT_RETENTION_MS };
      current = undefined;
    }
  }

  const unavailable = { error: { code: "unavailable", message: "GitHub Developer setup is unavailable. Try again." } };
  const unauthorized = { error: { code: "unauthorized", message: "Authentication is required." } };
  const invalid = { error: { code: "invalid_request", message: "Invalid GitHub Developer setup request." } };
  const notFound = { error: { code: "not_found", message: "GitHub Developer setup was not found." } };
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    let principal: ReturnType<typeof options.getPrincipal>;
    try { principal = options.getPrincipal(c); }
    catch (error: unknown) {
      if (isRequestPrincipalError(error) && mapRequestPrincipalError(error).status === 401) return c.json(unauthorized, 401);
      console.warn("[github-setup] Could not verify Computer owner:", error instanceof Error ? error.name : "UnknownError");
      return c.json(unavailable, 503);
    }
    if (!principal) return c.json(unauthorized, 401);
    if (closed || !options.ownerId) return c.json(unavailable, 503);
    if (principal.userId !== options.ownerId) {
      return c.json({ error: { code: "forbidden", message: "This operation requires the Computer owner." } }, 403);
    }
    return next();
  });
  routes.use("*", bodyLimit({ maxSize: 512, onError: c => c.json({ error: { code: "body_too_large", message: "Request body is too large." } }, 413) }));

  async function hasEmptyBody(c: Context): Promise<boolean> {
    // JSON requests must pass the browser CORS preflight across origins.
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return false;
    try { return emptyBody.safeParse(await c.req.json()).success; }
    catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      if (!(error instanceof SyntaxError)) console.warn("[github-setup] Invalid request:", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }

  function find(id: string): GithubDeveloperSetupOperation | undefined {
    if (current?.view.id === id) return current.view;
    if (retained && Date.now() >= retained.expiresAt) retained = undefined;
    return retained?.view.id === id ? retained.view : undefined;
  }

  routes.post("/", async c => {
    if (!await hasEmptyBody(c)) return c.json(invalid, 400);
    if (closed) return c.json(unavailable, 503);
    if (current) return c.json(current.view);
    const { promise: stopped, resolve: notifyStopped } = Promise.withResolvers<false>();
    const attempt: Attempt = { view: { id: randomUUID(), state: "starting" }, abort: new AbortController(), stopped, notifyStopped };
    current = attempt;
    attempt.done = run(attempt);
    return c.json(attempt.view);
  });
  routes.get("/:id", c => {
    const id = operationId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(invalid, 400);
    const view = find(id.data);
    return view ? c.json(view) : c.json(notFound, 404);
  });
  routes.post("/:id/cancel", async c => {
    const id = operationId.safeParse(c.req.param("id"));
    if (!id.success || !await hasEmptyBody(c)) return c.json(invalid, 400);
    if (current?.view.id === id.data) stop(current, "cancelled");
    const view = find(id.data);
    return view ? c.json(view) : c.json(notFound, 404);
  });
  options.app.route(SETUP_PATH, routes);

  return {
    async close() {
      closed = true;
      if (!current) return;
      stop(current, "cancelled");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([current.done, new Promise<void>(resolve => {
          deadline = setTimeout(() => {
            console.warn("[github-setup] Setup did not settle before shutdown");
            resolve();
          }, 10_000);
        })]);
      } finally { clearTimeout(deadline); }
    },
  };
}
