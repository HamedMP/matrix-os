import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createDatabaseAccessService } from "../../packages/gateway/src/database-access/service.js";
import { createDatabaseExporter } from "../../packages/gateway/src/database-access/export.js";
import { createDatabaseAccessRoutes } from "../../packages/gateway/src/database-access/routes.js";
const databaseUrl=process.env.MATRIX_OWNER_DATABASE_TEST_URL;
afterEach(()=>vi.unstubAllEnvs());
describe.skipIf(!databaseUrl)("owner auth, credential and full export integration",()=>{
  it("authenticates real owner requests, streams/restores the data and excludes private login metadata",async()=>{
    vi.stubEnv("MATRIX_USER_ID","test-owner");vi.stubEnv("NODE_ENV","test");
    const url=new URL(databaseUrl!);
    const pool=new pg.Pool({connectionString:databaseUrl,max:2});
    const service=createDatabaseAccessService({databaseUrl:databaseUrl!,ownerId:"test-owner",key:randomBytes(32)});
    const exporter=createDatabaseExporter({databaseUrl:databaseUrl!});
    const app=new Hono();app.use("*",authMiddleware("owner-runtime-token"));
    app.route("/api/database",createDatabaseAccessRoutes({ownerId:"test-owner",service,exporter}));
    const request=(path:string,body:unknown={},bearer="owner-runtime-token")=>app.request(`/api/database${path}`,{method:"POST",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json","X-Matrix-Database-Action":"1"},body:JSON.stringify(body)});
    try {
      await pool.query('CREATE TABLE public.export_evidence (id integer PRIMARY KEY, text_value text)');
      await pool.query("INSERT INTO public.export_evidence VALUES (1,'all owner data survives')");
      expect((await request("/credentials/reveal",{},"invalid")).status).toBe(401);
      expect((await app.request("/api/database?token=owner-runtime-token")).status).toBe(401);
      const metadata=await app.request("/api/database",{headers:{authorization:"Bearer owner-runtime-token"}});
      expect(metadata.status).toBe(200);expect(await metadata.text()).not.toContain("test-service-password");
      const login=await request("/credentials/reveal");expect(login.status).toBe(200);
      const receipt=await login.json() as {username:string;password:string};expect(receipt.username).toBe("matrix_owner");
      const dump=await request("/export",{confirm:"export"});expect(dump.status).toBe(200);
      const bytes=Buffer.from(await dump.arrayBuffer());expect(bytes.subarray(0,5).toString()).toBe("PGDMP");
      await pool.query('CREATE DATABASE owner_export_restore');
      await new Promise<void>((resolve,reject)=>{
        const child=spawn("pg_restore",["--no-owner","--no-acl","--exit-on-error","--dbname=owner_export_restore"],{env:{PATH:process.env.PATH,PGHOST:"127.0.0.1",PGPORT:url.port,PGUSER:"matrix",PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:"5"},stdio:["pipe","ignore","ignore"]});
        child.once("error",reject);child.once("close",code=>code===0?resolve():reject(new Error("Restore failed")));child.stdin.end(bytes);
      });
      const restoreUrl=new URL(databaseUrl!);restoreUrl.pathname="/owner_export_restore";
      const restored=new pg.Pool({connectionString:restoreUrl.toString(),max:1});
      try {expect((await restored.query("SELECT text_value FROM public.export_evidence")).rows).toEqual([{text_value:"all owner data survives"}]);expect((await restored.query("SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname='_matrix_owner_access'")).rows[0].count).toBe(0);}finally{await restored.end();}
    } finally {
      await exporter.close();await service.close();
      await pool.query('DROP DATABASE IF EXISTS owner_export_restore WITH (FORCE)');
      await pool.query('DROP TABLE IF EXISTS public.export_evidence');
      await pool.query('DROP SCHEMA IF EXISTS _matrix_owner_access CASCADE');
      await pool.query('DROP OWNED BY matrix_owner');
      await pool.query('DROP ROLE IF EXISTS matrix_owner');await pool.end();
    }
  },30_000);
});
