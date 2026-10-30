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
