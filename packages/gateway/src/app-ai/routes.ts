import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { APP_AI_TIMEOUT_MS, AppAiRequestSchema, AppAiResultSchema, AppAiRoutesRequestSchema, AppAiRoutesSchema, type AppAiRequest, type AppAiResult, type AppAiRoutes } from "@matrix-os/contracts";
interface Options {
    lifecycle?: { signal: AbortSignal; track<T>(operation: () => Promise<T>): Promise<T> };
    /** Cheap trusted principal check, before any shared policy-read budget. */
    authorizeOwner?: (context: Context) => boolean;
    authorize: (context: Context, app: string) => Promise<boolean>;
    generate: (request: AppAiRequest, signal: AbortSignal) => Promise<AppAiResult>;
    discover?: (app: string, signal: AbortSignal) => Promise<AppAiRoutes>;
    authorizeSelection?: (request:AppAiRequest)=>Promise<boolean>;
}
class AppAiBusyError extends Error {
}
/** Mounted behind gateway auth; authorize additionally enforces owner and app grant. */
export function createAppAiRoutes(options: Options): Hono {
    const routes = new Hono();
    routes.use('*', async (c, next) => {
        if (options.lifecycle?.signal.aborted) return c.json({ error: 'App AI is unavailable' }, 503);
        await next();
    });
    let inFlight = 0;
    let windowStart = 0;
    let requests = 0;
    let authorizationRequests = 0;
    let ownerDenials = 0;
    function refreshWindow() {
        const now = Date.now();
        if (now - windowStart >= 60000) {
            windowStart = now;
            requests = 0;
            authorizationRequests = 0;
            ownerDenials = 0;
        }
    }
    function ownerAllowed(c: Context): boolean {
        if (!options.authorizeOwner || options.authorizeOwner(c)) return true;
        refreshWindow();
        if (ownerDenials >= 100) throw new AppAiBusyError();
        ownerDenials++;
        return false;
    }
    function reserveAuthorized(signal: AbortSignal) {
        signal.throwIfAborted();
        refreshWindow();
        if (requests >= 10) throw new AppAiBusyError();
        requests++;
    }
    async function bounded<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
        refreshWindow();
        // Policy authorization is bounded separately from approved app work.
        // Denials cannot exhaust the ten discovery/inference reservations.
        if (inFlight >= 2 || authorizationRequests >= 100)
            throw new AppAiBusyError();
        signal.throwIfAborted();
        authorizationRequests++;
        inFlight++;
        let onAbort: (() => void) | undefined;
        // Keep the slot until work drains even when a driver ignores cancellation.
        const pending = (options.lifecycle ? options.lifecycle.track(operation) : Promise.resolve().then(operation)).finally(() => { inFlight--; });
        const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error("App AI request cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted)
                onAbort();
        });
        try {
            return await Promise.race([pending, cancelled]);
        }
        finally {
            if (onAbort)
                signal.removeEventListener("abort", onAbort);
        }
    }
    const requestSignal = (c: Context) => AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(APP_AI_TIMEOUT_MS), ...(options.lifecycle ? [options.lifecycle.signal] : [])]);
    const unavailable = (c: Context, error: unknown) => {
        if (error instanceof AppAiBusyError)
            return c.json({ error: "App AI is busy" }, 429);
        console.warn("[app-ai] request failed:", error instanceof Error ? error.name : "UnknownError");
        return c.json({ error: "App AI is unavailable" }, 503);
    };
    routes.get("/routes", async (c) => {
        const parsed = AppAiRoutesRequestSchema.safeParse({ app: c.req.query("app") });
        const params = new URL(c.req.url).searchParams;
        if (!parsed.success || params.getAll("app").length !== 1 || [...params.keys()].some(key => key !== "app"))
            return c.json({ error: "Invalid app AI request" }, 400);
        try {
            if (!ownerAllowed(c)) return c.json({error:"App AI access denied"},403);
            const signal = requestSignal(c);
            return await bounded(signal, async () => {
                if (!await options.authorize(c, parsed.data.app)) return c.json({error:"App AI access denied"},403);
                signal.throwIfAborted();
                const discover = options.discover;
                if (!discover) return c.json({error:"App AI is unavailable"},503);
                reserveAuthorized(signal);
                return c.json(AppAiRoutesSchema.parse(await discover(parsed.data.app,signal)));
            });
        }
        catch (error) {
            return unavailable(c, error);
        }
    });
    routes.post("/", bodyLimit({ maxSize: 65536 }), async (c) => {
        let body: unknown;
        try {
            body = await c.req.json();
        }
        catch (error) {
            if (error instanceof Error && error.name === "BodyLimitError")
                return c.json({ error: "Request too large" }, 413);
            if (!(error instanceof SyntaxError))
                console.warn("[app-ai] body read failed", error instanceof Error ? error.name : "UnknownError");
            return c.json({ error: "Invalid app AI request" }, 400);
        }
        const parsed = AppAiRequestSchema.safeParse(body);
        if (!parsed.success)
            return c.json({ error: "Invalid app AI request" }, 400);
        try {
            if (!ownerAllowed(c)) return c.json({error:"App AI access denied"},403);
            const signal = requestSignal(c);
            return await bounded(signal,async()=>{
                if (!await options.authorize(c,parsed.data.app)) return c.json({error:"App AI access denied"},403);
                signal.throwIfAborted();
                if(options.authorizeSelection && !await options.authorizeSelection(parsed.data))return c.json({error:"App AI access denied"},403);
                reserveAuthorized(signal);
                return c.json(AppAiResultSchema.parse(await options.generate(parsed.data,signal)));
            });
        }
        catch (error) {
            return unavailable(c, error);
        }
    });
    return routes;
}
