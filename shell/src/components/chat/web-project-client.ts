// Gateway transport for adding and deleting projects from the web OS views.
// Mirrors Electron Desktop's requests and timeouts. Only allowlisted copy
// reaches the UI; raw gateway messages and transport errors stay in logs.
import {
  CLONE_FAILED_COPY, COMPUTER_UNREACHABLE_COPY, FOLDER_CONFLICT_COPY, PROJECT_ACTIONS_UNAVAILABLE, SESSION_EXPIRED_COPY,
  cloneErrorMessage, projectLifecycleErrorMessage, projectLifecyclePath, type AddProjectOutcome,
} from "@matrix-os/ui";
import { z } from "zod/v4";
import { ProjectsResponseSchema, WebProjectSchema, type WebProject } from "./web-projects";

const REQUEST_TIMEOUT_MS = 30_000;
// Gateway clone/create work is bounded at five minutes; waiting slightly longer
// lets an idempotent replay return the original persisted result.
const LONG_REQUEST_TIMEOUT_MS = 310_000;
const LIST_TIMEOUT_MS = 10_000;
const SAFE_CODE = /^[a-z][a-z0-9_]{2,48}$/;
const ProjectBody = z.object({ project: WebProjectSchema });
const FolderBody = z.object({ path: z.string().min(1).max(4096) });

type Failure = { kind: "http"; status: number; code: string | null } | { kind: "timeout" } | { kind: "offline" };
type Result = { ok: true; body: unknown } | { ok: false; failure: Failure };

const CATEGORY_COPY: Record<"unauthorized" | "timeout" | "offline" | "server", string> = {
  unauthorized: SESSION_EXPIRED_COPY,
  timeout: "The request timed out. Please try again.",
  offline: "Can't reach Matrix OS. Check your connection.",
  server: "Something went wrong. Please try again.",
};

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : error;
    return typeof code === "string" && SAFE_CODE.test(code) ? code : null;
  } catch (cause: unknown) {
    console.warn("[web-projects] error body unreadable", cause instanceof Error ? cause.name : "UnknownError");
    return null;
  }
}

async function send(gatewayUrl: string, path: string, body: unknown, timeoutMs: number): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause: unknown) {
    const timeout = cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError");
    console.warn("[web-projects] request failed", path, cause instanceof Error ? cause.name : "UnknownError");
    return { ok: false, failure: timeout ? { kind: "timeout" } : { kind: "offline" } };
  }
  if (!response.ok) {
    const code = await errorCode(response);
    console.warn("[web-projects] request rejected", path, response.status, code ?? "no_code");
    return { ok: false, failure: { kind: "http", status: response.status, code } };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch (cause: unknown) {
    console.warn("[web-projects] response unreadable", path, cause instanceof Error ? cause.name : "UnknownError");
    return { ok: false, failure: { kind: "http", status: 502, code: null } };
  }
}

/** Sends once, then replays the same idempotent request with a longer wait if the first one timed out. */
async function sendWithReplay(gatewayUrl: string, path: string, body: unknown): Promise<Result> {
  const first = await send(gatewayUrl, path, body, REQUEST_TIMEOUT_MS);
  return !first.ok && first.failure.kind === "timeout" ? send(gatewayUrl, path, body, LONG_REQUEST_TIMEOUT_MS) : first;
}

function parsed<T>(result: Result, schema: z.ZodType<T>): T | null {
  if (!result.ok) return null;
  const value = schema.safeParse(result.body);
  if (!value.success) console.warn("[web-projects] response did not match the project contract");
  return value.success ? value.data : null;
}

export interface WebProjectClient {
  listProjects(): Promise<WebProject[] | null>;
  createProject(input: { name: string; description?: string; mode: "scratch" | "folder"; path?: string }): Promise<WebProject | null>;
  cloneProject(input: { url: string; name: string; displayName: string; description?: string; branch?: string; clientRequestId: string }): Promise<AddProjectOutcome<WebProject>>;
  createFolder(input: { name: string; parent: string; clientRequestId: string }): Promise<AddProjectOutcome<string>>;
  deleteProject(slug: string, confirmation: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export function createWebProjectClient(gatewayUrl: string): WebProjectClient {
  return {
    async listProjects() {
      try {
        const response = await fetch(`${gatewayUrl}/api/workspace/projects`, { redirect: "error", signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
        if (!response.ok) throw new Error("ProjectsUnavailable");
        const body = ProjectsResponseSchema.safeParse(await response.json());
        if (!body.success) throw new Error("ProjectsContractMismatch");
        return body.data.projects;
      } catch (cause: unknown) {
        console.warn("[web-projects] list unavailable", cause instanceof Error ? cause.name : "UnknownError");
        return null;
      }
    },
    async createProject(input) {
      const clientRequestId = `req_web_project_${crypto.randomUUID()}`;
      const body = input.mode === "folder"
        ? { name: input.name, description: input.description, mode: "folder" as const, path: input.path, clientRequestId }
        : { name: input.name, description: input.description, mode: "scratch" as const, clientRequestId };
      return parsed(await sendWithReplay(gatewayUrl, "/api/projects", body), ProjectBody)?.project ?? null;
    },
    async cloneProject(input) {
      const result = await send(gatewayUrl, "/api/projects/clone", {
        url: input.url,
        name: input.name,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        clientRequestId: input.clientRequestId,
      }, LONG_REQUEST_TIMEOUT_MS);
      if (result.ok) {
        const project = parsed(result, ProjectBody)?.project;
        return project ? { ok: true, value: { ...project, kind: "github" } } : { ok: false, message: "Couldn't create the project. Try again." };
      }
      const { failure } = result;
      if (failure.kind !== "http") return { ok: false, message: COMPUTER_UNREACHABLE_COPY };
      if (failure.status === 401 || failure.status === 403) return { ok: false, message: SESSION_EXPIRED_COPY };
      return { ok: false, message: failure.code ? cloneErrorMessage(failure.code) : CLONE_FAILED_COPY };
    },
    async createFolder(input) {
      const result = await sendWithReplay(gatewayUrl, "/api/projects/mkdir", input);
      if (result.ok) {
        const path = parsed(result, FolderBody)?.path;
        return path ? { ok: true, value: path } : { ok: false, message: "Couldn't create the folder. Try again." };
      }
      const { failure } = result;
      if (failure.kind === "http" && failure.code === "folder_conflict") return { ok: false, message: FOLDER_CONFLICT_COPY };
      if (failure.kind === "http" && (failure.status === 401 || failure.status === 403)) return { ok: false, message: SESSION_EXPIRED_COPY };
      return { ok: false, message: failure.kind === "http" ? CATEGORY_COPY.server : CATEGORY_COPY[failure.kind] };
    },
    async deleteProject(slug, confirmation) {
      const result = await send(gatewayUrl, projectLifecyclePath(slug), { type: "delete", confirmation, confirmTerminate: true }, REQUEST_TIMEOUT_MS);
      if (result.ok) return { ok: true };
      const { failure } = result;
      if (failure.kind !== "http") return { ok: false, message: CATEGORY_COPY[failure.kind] };
      const known = projectLifecycleErrorMessage(failure.code);
      if (known) return { ok: false, message: known };
      if (failure.status === 401 || failure.status === 403) return { ok: false, message: CATEGORY_COPY.unauthorized };
      if (failure.status === 404 && !failure.code) return { ok: false, message: PROJECT_ACTIONS_UNAVAILABLE };
      return { ok: false, message: CATEGORY_COPY.server };
    },
  };
}
