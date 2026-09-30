import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod/v4";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../../request-principal.js";
import { LocalChatImportJobError, type LocalChatImportJobs } from "./jobs.js";
import type { LocalChatImportPublisher } from "./publication.js";
const JobId = z.uuid();
const ChatId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).refine(value => !value.includes(".."));
const EmptyBody = z.object({}).strict();
function fail(c: Context, error: unknown): Response {
  if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Chat import request too large", code: "too_large" }, 413);
  if (isRequestPrincipalError(error)) { const mapped = mapRequestPrincipalError(error, "Chat import unavailable");
    if (mapped.log) console.warn("[chat/import] principal unavailable", error.name); return c.json(mapped.body, mapped.status); }
  if (error instanceof LocalChatImportJobError) { const status = error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : error.code === "capacity" ? 429 : error.code === "unavailable" ? 503 : 409;
    return c.json({ error: "Chat import unavailable", code: error.code }, status); }
  if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid Chat import request", code: "invalid_request" }, 400);
  console.warn("[chat/import] request unavailable", error instanceof Error ? error.name : "UnknownError");
  return c.json({ error: "Chat import unavailable", code: "unavailable" }, 503);
}
export function createLocalChatImportRoutes(options: {
  jobs: Pick<LocalChatImportJobs, "begin" | "get" | "presignParts" | "acknowledgePart" | "completeArchive" | "cancel"> | null;
  publisher: Pick<LocalChatImportPublisher, "archiveUrl" | "assetContent"> | null;
  wake(): void; getPrincipal(context: Context): RequestPrincipal;
}): Hono {
  const routes = new Hono();
  const owner = (c: Context) => ({ type: "personal" as const, ownerId: options.getPrincipal(c).userId });
  const jobs = () => { if (!options.jobs) throw new LocalChatImportJobError("unavailable"); return options.jobs; };
  const publisher = () => { if (!options.publisher) throw new LocalChatImportJobError("unavailable"); return options.publisher; };
  const smallBody = bodyLimit({ maxSize: 8 * 1024, onError: c => c.json({ error: "Chat import request too large", code: "too_large" }, 413) });
  routes.post("/api/chats/imports/local", smallBody, async c => { try {
    const principal = owner(c); return c.json(await jobs().begin(principal, await c.req.json()), 201);
  } catch (error: unknown) { return fail(c, error); } });
  routes.get("/api/chats/imports/local/:jobId", async c => { try {
    const principal = owner(c); return c.json(await jobs().get(principal, JobId.parse(c.req.param("jobId"))));
  } catch (error: unknown) { return fail(c, error); } });
  routes.post("/api/chats/imports/local/:jobId/parts", smallBody, async c => { try {
    const principal = owner(c); return c.json({ parts: await jobs().presignParts(principal, JobId.parse(c.req.param("jobId")), await c.req.json()) });
  } catch (error: unknown) { return fail(c, error); } });
  routes.post("/api/chats/imports/local/:jobId/parts/ack", smallBody, async c => { try {
    const principal = owner(c); return c.json(await jobs().acknowledgePart(principal, JobId.parse(c.req.param("jobId")), await c.req.json()));
  } catch (error: unknown) { return fail(c, error); } });
  routes.post("/api/chats/imports/local/:jobId/complete", smallBody, async c => { try {
    const principal = owner(c); const jobId = JobId.parse(c.req.param("jobId")); EmptyBody.parse(await c.req.json());
    const result = await jobs().completeArchive(principal, jobId); options.wake(); return c.json(result, 202);
  } catch (error: unknown) { return fail(c, error); } });
  routes.delete("/api/chats/imports/local/:jobId", smallBody, async c => { try {
    const principal = owner(c); const jobId = JobId.parse(c.req.param("jobId"));
    if (c.req.raw.body) await c.req.arrayBuffer(); // Drain only through bodyLimit before any mutation.
    return c.json(await jobs().cancel(principal, jobId));
  } catch (error: unknown) { return fail(c, error); } });
  routes.get("/api/chats/imports/local/:jobId/archive", async c => { try {
    const principal = owner(c); c.header("Cache-Control", "private, no-store");
    return c.json(await publisher().archiveUrl(principal, JobId.parse(c.req.param("jobId"))));
  } catch (error: unknown) { return fail(c, error); } });
  routes.get("/api/chats/:chatId/imports/assets/:assetId/content", async c => { try {
    const principal = owner(c); return await publisher().assetContent(principal, ChatId.parse(c.req.param("chatId")), JobId.parse(c.req.param("assetId")), c.req.raw.signal);
  } catch (error: unknown) { return fail(c, error); } });
  return routes;
}
