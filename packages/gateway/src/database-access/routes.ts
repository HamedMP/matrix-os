import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { hasVerifiedRuntimeBearer, isRequestPrincipalError, requireRequestPrincipal } from "../request-principal.js";
import { createRateLimiter } from "../security/rate-limiter.js";

export interface DatabaseAccessRouteService {
  info(): Promise<{connection:{host:string;port:number;database:string;username:string};credentialReady:boolean}>;
  reveal(): Promise<{username:string;password:string}>;
  reset(): Promise<{username:string;password:string}>;
  consoleCommand(): Promise<string>;
}
export interface DatabaseExporter { export(signal: AbortSignal): Promise<Response>; }
const Empty = z.object({}).strict();
const Reset = z.object({confirm:z.literal("reset")}).strict();
const Export = z.object({confirm:z.literal("export")}).strict();
const ERROR = "Database access unavailable";

export function createDatabaseAccessRoutes(options: {
  ownerId: string | null;
  service: DatabaseAccessRouteService | null;
  exporter: DatabaseExporter | null;
}): Hono {
  const routes = new Hono();
  const reads = createRateLimiter({maxAttempts:60,windowMs:60_000,lockoutMs:0,maxKeys:8});
  const actions = createRateLimiter({maxAttempts:10,windowMs:60_000,lockoutMs:0,maxKeys:8});
  routes.use("*", async (c,next) => {
    c.header("Cache-Control","private, no-store");
    c.header("Pragma","no-cache");
    c.header("Referrer-Policy","no-referrer");
    if (!options.ownerId) return c.json({error:ERROR},503);
    try {
      const principal = requireRequestPrincipal(c, {configuredUserId:options.ownerId,isTrustedSingleUserGateway:true});
      if (principal.userId !== options.ownerId
        || principal.source === "dev-default" || !hasVerifiedRuntimeBearer(c)) {
        return c.json({error:"Forbidden"},403);
      }
      if (!reads.check(principal.userId)) return c.json({error:ERROR},429);
      await next();
    } catch(error:unknown) {
      if (isRequestPrincipalError(error)) return c.json({error:"Unauthorized"},401);
      console.warn("[database-access] authorization unavailable",error instanceof Error ? error.name : "UnknownError");
      return c.json({error:ERROR},503);
    }
  });
  routes.get("/",async c => {
    if (!options.service) return c.json({error:ERROR},503);
    try { return c.json(await options.service.info()); }
    catch(error:unknown) { return failure(c,error); }
  });
  const limit = bodyLimit({maxSize:1024,onError:c=>c.json({error:"Invalid request"},413)});
  for (const path of ["/credentials/reveal","/credentials/reset","/terminal","/export"] as const) {
    routes.post(path,limit,async c => {
      if (c.req.header("X-Matrix-Database-Action") !== "1") return c.json({error:"Forbidden"},403);
      if (c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") return c.json({error:"Invalid request"},400);
      if (!actions.check(options.ownerId!)) return c.json({error:ERROR},429);
      try {
        const body:unknown = await c.req.json();
        (path === "/credentials/reset" ? Reset : path === "/export" ? Export : Empty).parse(body);
        if (!options.service) return c.json({error:ERROR},503);
        if (path === "/credentials/reveal") {
          const credential = await options.service.reveal();
          console.info("[database-access] owner credential revealed");
          return c.json(credential);
        }
        if (path === "/credentials/reset") {
          const credential = await options.service.reset();
          console.info("[database-access] owner credential reset");
          return c.json(credential);
        }
        if (path === "/terminal") return c.json({command:await options.service.consoleCommand()});
        if (!options.exporter) return c.json({error:ERROR},503);
        await options.service.info(); // Prove dedicated runtime ownership/layout before starting pg_dump.
        const response = await options.exporter.export(c.req.raw.signal);
        response.headers.set("Cache-Control","private, no-store");
        response.headers.set("Pragma","no-cache");
        response.headers.set("Referrer-Policy","no-referrer");
        response.headers.set("Content-Type","application/octet-stream");
        response.headers.set("Content-Disposition",'attachment; filename="matrix-database.dump"');
        response.headers.set("X-Content-Type-Options","nosniff");
        console.info("[database-access] owner export started");
        return response;
      } catch(error:unknown) { return failure(c,error); }
    });
  }
  return routes;
}
function failure(c:Context,error:unknown):Response {
  if (error instanceof Error && error.name === "BodyLimitError") return c.json({error:"Invalid request"},413);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({error:"Invalid request"},400);
  console.warn("[database-access] action unavailable",error instanceof Error ? error.name : "UnknownError");
  return c.json({error:ERROR},503);
}
