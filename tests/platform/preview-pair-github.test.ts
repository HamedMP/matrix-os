import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import * as adapter from "../../packages/platform/src/preview-pair/github.js";
const sha="c".repeat(40), sourceSha="a".repeat(40);
const receipt={runId:123,artifactId:456,sourceSha,workflowSha:sha,platform:"linux",arch:"x64",sha256:"e".repeat(64),sizeBytes:1000};
function setup(fault?: string){
  const archive=zipSync({"456.json":strToU8(JSON.stringify(fault==="wrong receipt"?{...receipt,sourceSha:"b".repeat(40)}:receipt))});
  const artifact={id:789,name:"preview-pair-source-receipts",expired:false,digest:`sha256:${createHash("sha256").update(archive).digest("hex")}`,size_in_bytes:archive.length,workflow_run:{id:123}};
  const run={id:123,run_attempt:1,event:"workflow_dispatch",status:"completed",conclusion:"success",path:".github/workflows/desktop-build.yml",head_sha:sha,repository:{full_name:"HamedMP/matrix-os"},head_repository:{full_name:"HamedMP/matrix-os"}};
  if(fault==="unreviewed")run.head_sha="d".repeat(40);
  if(fault==="wrong workflow")run.path=".github/workflows/untrusted.yml";
  const fetchImpl=vi.fn(async (url: any,init?: RequestInit)=>{
    const u=String(url);
    if(u==="https://productionresultssa1.blob.core.windows.net/archive")return new Response(archive);
    expect(init?.signal).toBeDefined();
    if(u.endsWith("/artifacts/789/zip"))return new Response(null,{status:302,headers:{location:fault==="redirect"?"http://127.0.0.1/secrets":"https://productionresultssa1.blob.core.windows.net/archive"}});
    if(u.endsWith("/runs/123/artifacts?per_page=17"))return Response.json({total_count:fault==="incomplete"?20:1,artifacts:[artifact]});
    if(u.endsWith("/artifacts/789"))return Response.json(fault==="digest"?{...artifact,digest:`sha256:${"f".repeat(64)}`}:artifact);
    if(u.endsWith("/artifacts/456"))return Response.json({id:456,name:`preview-pair-desktop-${sourceSha}-linux-x64`,expired:false,digest:`sha256:${receipt.sha256}`,size_in_bytes:1000,workflow_run:{id:123}});
    if(u.endsWith("/runs/123/attempts/1"))return Response.json(run);
    if(u.endsWith("/runs/123"))return Response.json(fault==="later failed rerun"?{...run,run_attempt:2,conclusion:"failure"}:run);
    if(u.includes("/git/commits/"))return Response.json({sha,tree:{sha:"f".repeat(40)}});
    return new Response(null,{status:404});
  });
  const github=(adapter as any).createPreviewPairGitHub({token:"read-only-fixture",reviewedControllerSha:sha,fetchImpl});
  return {github,fetchImpl,run};
}
describe("authenticated GitHub pair provenance adapter",()=>{
  it("reads a small trusted receipt and binds it to the actual artifact and reviewed execution",async()=>{
    const {github,fetchImpl}=setup(); expect(await github.buildSource(123,456)).toEqual({runId:123,artifactId:456,sourceSha,workflowSha:sha});
    const blob=fetchImpl.mock.calls.find(([url])=>String(url).includes("productionresultssa1.blob")); expect(new Headers(blob?.[1]?.headers).has("authorization")).toBe(false);
  });
  it.each(["unreviewed","wrong workflow","redirect","incomplete","digest","wrong receipt"])("refuses %s without trusting downloaded claims",async fault=>{
    await expect(setup(fault).github.buildSource(123,456)).rejects.toThrow("unavailable");
  });
  it("retains the successful artifact's immutable first attempt when a later rerun fails",async()=>{
    const s=setup("later failed rerun");
    await expect(s.github.buildSource(123,456)).resolves.toMatchObject({runId:123,sourceSha});
    expect(s.fetchImpl.mock.calls.some(([url])=>String(url).endsWith("/runs/123/attempts/1"))).toBe(true);
  });
  it("uses immutable reviewed Git tree evidence for execution proof",async()=>{
    expect(await setup().github.controllerProof(123)).toEqual({controllerSha:sha,executionSha:sha,workflowPath:".github/workflows/desktop-build.yml",treeSha:"f".repeat(40)});
  });
  it("rejects caller-selected API paths before transport",async()=>{
    const {github,fetchImpl}=setup(); await expect(github.artifact("../../secrets")).rejects.toThrow(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
