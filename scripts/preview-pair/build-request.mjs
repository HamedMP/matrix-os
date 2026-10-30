const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validatePreviewPairBuild(input, pull, run) {
  if (!input || !/^[1-9][0-9]{0,8}$/.test(input.pr) || !/^[1-9][0-9]{0,2}$/.test(input.generation)
    || !SHA.test(input.sourceSha) || !UUID.test(input.pairId)
    || run?.repository !== "HamedMP/matrix-os" || run.event !== "workflow_dispatch"
    || !SHA.test(run.reviewedControllerSha) || run.sha !== run.reviewedControllerSha
    || pull?.number !== Number(input.pr) || pull.state !== "open" || pull.head?.sha !== input.sourceSha
    || pull.head?.repo?.full_name !== "HamedMP/matrix-os" || pull.base?.repo?.full_name !== "HamedMP/matrix-os") {
    throw new Error("Preview pair build is unavailable");
  }
  return { pr: Number(input.pr), sourceSha: input.sourceSha, pairId: input.pairId,
    generation: Number(input.generation), controllerSha: run.sha };
}

/** Fresh trusted runner: candidate output is never imported or executed here. */
export function createPreviewPairBuildReceipts(input, pull, run, artifacts) {
  const validated=validatePreviewPairBuild(input,pull,run);
  if(!Number.isSafeInteger(run.runId)||run.runId<1||!Array.isArray(artifacts)||artifacts.length>16) throw new Error("Preview artifacts unavailable");
  return [["linux","x64"],["darwin","arm64"],["darwin","x64"]].map(([platform,arch])=>{
    const name=`preview-pair-desktop-${validated.sourceSha}-${platform}-${arch}`;
    const matches=artifacts.filter(item=>item.name===name);
    const item=matches[0];
    if(matches.length!==1||!Number.isSafeInteger(item.id)||item.id<1||item.expired!==false
      ||!Number.isSafeInteger(item.size_in_bytes)||item.size_in_bytes<1||item.size_in_bytes>3*1024**3
      ||!/^sha256:[a-f0-9]{64}$/.test(item.digest)
      ||(item.workflow_run&&item.workflow_run.id!==run.runId)) throw new Error("Preview artifacts unavailable");
    return {runId:run.runId,artifactId:item.id,sourceSha:validated.sourceSha,workflowSha:run.sha,
      platform,arch,sha256:item.digest.slice(7),sizeBytes:item.size_in_bytes};
  });
}
