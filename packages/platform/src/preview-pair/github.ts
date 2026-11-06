import {createHash} from "node:crypto";
import {unzipSync} from "fflate";
import {z} from "zod/v4";
import {PreviewPairShaSchema,PreviewPairPrSchema} from "@matrix-os/contracts/preview-pair";
import {PreviewPairUpstreamError,readPreviewPairBytes,readPreviewPairJson} from "./http.js";
const Id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Repo=z.object({full_name:z.literal("HamedMP/matrix-os")});
const Run=z.object({id:Id,run_attempt:z.literal(1),event:z.literal("workflow_dispatch"),status:z.string(),conclusion:z.string().nullable(),
  actor:z.object({id:Id}).optional(),triggering_actor:z.object({id:Id}).optional(),
  path:z.string().max(256),head_sha:PreviewPairShaSchema,repository:Repo,head_repository:Repo});
const Artifact=z.object({id:Id,name:z.string().max(128),expired:z.literal(false),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size_in_bytes:Id,workflow_run:z.object({id:Id}).optional()});
const Receipt=z.strictObject({runId:Id,artifactId:Id,sourceSha:PreviewPairShaSchema,workflowSha:PreviewPairShaSchema,
  platform:z.enum(["linux","darwin","win32"]),arch:z.enum(["x64","arm64"]),sha256:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:Id});
/** Fixed provider API only; archive redirects never receive its bearer. */
export function createPreviewPairGitHub(options:{token:string;reviewedControllerSha:string;fetchImpl?:typeof fetch}) {
  PreviewPairShaSchema.parse(options.reviewedControllerSha);
  if(!options.token)throw new PreviewPairUpstreamError();
  const fetchImpl=options.fetchImpl??fetch,base="https://api.github.com/repos/HamedMP/matrix-os";
  const headers={Authorization:`Bearer ${options.token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  const api=(path:string)=>fetchImpl(`${base}${path}`,{headers,redirect:"error",signal:AbortSignal.timeout(10_000)}).then(response=>readPreviewPairJson(response));
  async function run(id:number){return Run.parse(await api(`/actions/runs/${Id.parse(id)}/attempts/1`));}
  async function reviewedRun(id:number,workflow=".github/workflows/desktop-build.yml"){
    const record=await run(id),path=record.path.split("@")[0];
    if(record.id!==id||record.head_sha!==options.reviewedControllerSha||path!==workflow)throw new PreviewPairUpstreamError();
    return {...record,path};
  }
  async function artifact(id:number){return Artifact.parse(await api(`/actions/artifacts/${Id.parse(id)}`));}
  async function smallArtifact(id:number){
    const metadata=await artifact(id);
    if(metadata.size_in_bytes>256*1024)throw new PreviewPairUpstreamError();
    const redirect=await fetchImpl(`${base}/actions/artifacts/${id}/zip`,{headers,redirect:"manual",signal:AbortSignal.timeout(10_000)});
    if(redirect.status!==302)throw new PreviewPairUpstreamError();
    const location=redirect.headers.get("location"); if(!location||location.length>8192)throw new PreviewPairUpstreamError();
    const url=new URL(location);
    if(url.protocol!=="https:"||url.username||url.password||url.port
      || !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname))throw new PreviewPairUpstreamError();
    const bytes=await readPreviewPairBytes(await fetchImpl(url,{redirect:"error",signal:AbortSignal.timeout(30_000)}),256*1024);
    if(bytes.length!==metadata.size_in_bytes||`sha256:${createHash("sha256").update(bytes).digest("hex")}`!==metadata.digest)throw new PreviewPairUpstreamError();
    let total=0,count=0;
    const files=unzipSync(bytes,{filter:file=>{
      total+=file.originalSize;count++;
      if(count>8||total>64*1024||!file.name.match(/^[A-Za-z0-9-]+\.json$/))throw new PreviewPairUpstreamError();
      return true;
    }});
    return files;
  }
  return {
    pullRequest:async(pr:number)=>api(`/pulls/${PreviewPairPrSchema.parse(pr)}`),
    artifact,
    build:async(id:number)=>reviewedRun(id),
    async controllerProof(id:number){
      const record=await reviewedRun(id);
      const commit=z.object({sha:PreviewPairShaSchema,tree:z.object({sha:PreviewPairShaSchema})}).parse(await api(`/git/commits/${record.head_sha}`));
      if(commit.sha!==record.head_sha)throw new PreviewPairUpstreamError();
      return {controllerSha:options.reviewedControllerSha,executionSha:record.head_sha,workflowPath:record.path,treeSha:commit.tree.sha};
    },
    async buildSource(runId:number,artifactId:number){
      try {
        const record=await reviewedRun(Id.parse(runId));
        if(record.status!=="completed"||record.conclusion!=="success")throw new PreviewPairUpstreamError();
        const page=z.object({total_count:z.number().int().min(0).max(16),artifacts:z.array(Artifact).max(16)})
          .parse(await api(`/actions/runs/${runId}/artifacts?per_page=17`));
        if(page.total_count!==page.artifacts.length)throw new PreviewPairUpstreamError();
        const matches=page.artifacts.filter(item=>item.name==="preview-pair-source-receipts");
        if(matches.length!==1||(matches[0]!.workflow_run&&matches[0]!.workflow_run.id!==runId))throw new PreviewPairUpstreamError();
        const files=await smallArtifact(matches[0]!.id),bytes=files[`${Id.parse(artifactId)}.json`];
        if(!bytes)throw new PreviewPairUpstreamError();
        const receipt=Receipt.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))),actual=await artifact(artifactId);
        if(receipt.runId!==runId||receipt.artifactId!==artifactId||receipt.workflowSha!==record.head_sha
          ||actual.workflow_run?.id!==runId||actual.digest!==`sha256:${receipt.sha256}`||actual.size_in_bytes!==receipt.sizeBytes
          ||actual.name!==`preview-pair-desktop-${receipt.sourceSha}-${receipt.platform}-${receipt.arch}`)throw new PreviewPairUpstreamError();
        return {runId,artifactId,sourceSha:receipt.sourceSha,workflowSha:receipt.workflowSha};
      }catch(error:unknown){console.warn("[preview-pair] artifact proof unavailable",error instanceof Error?error.name:"UnknownError");throw new PreviewPairUpstreamError();}
    },
    api, reviewedRun, smallArtifact,
  };
}
