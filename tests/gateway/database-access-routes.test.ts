import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDatabaseAccessRoutes } from "../../packages/gateway/src/database-access/routes.js";
import { markAuthContextReady, markVerifiedRuntimeBearer, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";

const secret = "database-owner-only-password";
function setup(identity: string | null = "owner", verified = true) {
  const service = { info: vi.fn(async () => ({ connection: { host:"127.0.0.1", port:5432, database:"matrix", username:"matrix_owner" }, credentialReady:true })),
    reveal: vi.fn(async () => ({username:"matrix_owner",password:secret})), reset:vi.fn(async () => ({username:"matrix_owner",password:secret})),
    consoleCommand:vi.fn(async () => "psql -h 127.0.0.1 -U matrix_owner -d matrix -W") };
  const exporter = { export:vi.fn(async () => new Response(new Uint8Array([80,71,68,77,80])) ) };
  const app = new Hono();
  app.use("*", async (c,next) => { markAuthContextReady(c); if (identity) setPlatformVerifiedPrincipal(c,identity); if (verified) markVerifiedRuntimeBearer(c); await next(); });
  app.route("/api/database", createDatabaseAccessRoutes({service, exporter, ownerId:"owner"}));
  const post = (path:string,body:unknown = {}, headers: Record<string,string> = {}) => app.request(`/api/database${path}`, {method:"POST",headers:{"Content-Type":"application/json","X-Matrix-Database-Action":"1",...headers},body:JSON.stringify(body)});
  return {app,service,exporter,post};
}
describe("owner database routes", () => {
  it("returns only connection metadata and never a password in info",async()=>{const {app}=setup();const r=await app.request("/api/database");expect(r.status).toBe(200);expect(await r.text()).not.toContain(secret);expect(r.headers.get("cache-control")).toContain("no-store");});
  it.each(["/credentials/reveal","/credentials/reset","/terminal","/export"])("denies a different principal on %s",async path=>{const s=setup("member");expect((await s.post(path)).status).toBe(403);expect(s.service.reveal).not.toHaveBeenCalled();expect(s.exporter.export).not.toHaveBeenCalled();});
  it("does not permit absent identity or owner misconfiguration",async()=>{const s=setup(null,false);expect((await s.post("/credentials/reveal")).status).not.toBe(200);const app=new Hono();app.route("/api/database",createDatabaseAccessRoutes({service:s.service,exporter:s.exporter,ownerId:null}));expect((await app.request("/api/database")).status).toBe(503);});
  it("denies scoped actor proof without verified owner bearer",async()=>{const s=setup("owner",false);expect((await s.post("/credentials/reveal")).status).toBe(403);expect(s.service.reveal).not.toHaveBeenCalled();});
  it("reveals only through explicit JSON action",async()=>{const s=setup();expect((await s.post("/credentials/reveal",{}, {"X-Matrix-Database-Action":""})).status).toBe(403);expect((await s.post("/credentials/reveal",{}, {"Content-Type":"text/plain"})).status).toBe(400);const r=await s.post("/credentials/reveal");expect(await r.json()).toEqual({username:"matrix_owner",password:secret});expect(r.headers.get("cache-control")).toContain("no-store");});
  it("requires exact reset/export confirmations, rejects unknown keys and oversize",async()=>{const s=setup();expect((await s.post("/credentials/reset")).status).toBe(400);expect((await s.post("/export")).status).toBe(400);expect((await s.post("/credentials/reset",{confirm:"reset",extra:true})).status).toBe(400);expect((await s.post("/credentials/reveal",{padding:"a".repeat(2048)})).status).toBe(413);expect((await s.post("/credentials/reset",{confirm:"reset"})).status).toBe(200);});
  it("returns only a password-free SQL command",async()=>{const s=setup();const r=await s.post("/terminal");expect(await r.json()).toEqual({command:await s.service.consoleCommand()});});
  it("exports an attachment with no cache",async()=>{const s=setup();const r=await s.post("/export",{confirm:"export"});expect(r.status).toBe(200);expect(r.headers.get("content-disposition")).toContain("matrix-database.dump");expect(r.headers.get("cache-control")).toContain("no-store");});
  it("never leaks backend error strings",async()=>{const s=setup();s.service.reveal.mockRejectedValueOnce(new Error("postgres://secret@internal/root"));const r=await s.post("/credentials/reveal");expect(r.status).toBe(503);expect(await r.json()).toEqual({error:"Database access unavailable"});});
  it("bounds credential actions per owner",async()=>{const s=setup();let r:Response;for(let i=0;i<12;i++) r=await s.post("/credentials/reveal");expect(r!.status).toBe(429);});
});
