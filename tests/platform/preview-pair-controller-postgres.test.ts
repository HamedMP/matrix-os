import {createPreviewPairSources} from "../../packages/platform/src/preview-pair/sources.js";
import {verifyPreviewPairCandidate} from "../../packages/platform/src/preview-pair/provenance.js";
import {previewPairProvenanceFixture} from "./preview-pair-provenance-fixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { requestPreviewPairUpdate } from "../../packages/platform/src/preview-pair/update.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { admitPreviewPair } from "../../packages/platform/src/preview-pair/admission.js";
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("durable reviewed-controller ownership", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f=await createSeededPreviewPair(); },30_000);
  afterEach(async () => { await f?.destroy(); });
  it("preserves the original run on idempotent admission",async () => {
    await f.db.executor.updateTable("preview_pair_generations").set({controller_run_id:"123"}).execute();
    await admitPreviewPair(f.db,f.config,{pairId:f.pair.pair_id,pr:f.pair.pr,requesterId:"user_requester",sourceSha:f.pair.source_sha,candidate:f.candidate,controllerRunId:456},f.prepare,PAIR_NOW);
    const g=await f.db.executor.selectFrom("preview_pair_generations").selectAll().executeTakeFirstOrThrow();
    expect(g.controller_run_id).toBe("123");
  });
  it("records the admission run even when both fixture owners are busy",async () => {
    const pairId="11234567-89ab-4cde-8fab-0123456789ab";
    const candidate={...f.candidate,browserOrigin:f.candidate.browserOrigin.replace(f.pair.pair_id.slice(0,8),pairId.slice(0,8)),apiOrigin:f.candidate.apiOrigin.replace(f.pair.pair_id.slice(0,8),pairId.slice(0,8))};
    await admitPreviewPair(f.db,f.config,{pairId,pr:3030,requesterId:"user_requester",sourceSha:f.pair.source_sha,candidate,controllerRunId:456},f.prepare,PAIR_NOW);
    const g=await f.db.executor.selectFrom("preview_pair_generations").selectAll().where("pair_id","=",pairId).executeTakeFirstOrThrow();
    expect(g.controller_run_id).toBe("456");
  });
  it("canonical channel history prevents reusing a promoted release as an unpromoted candidate",async()=>{
    const proof=previewPairProvenanceFixture();proof.input.hostBundleSha256=f.candidate.hostBundleSha256;
    const source=createPreviewPairSources(f.db,proof.source,proof.source.authority);
    await expect(verifyPreviewPairCandidate(proof.input,proof.expected,source,f.config,PAIR_NOW)).resolves.toMatchObject({sourceSha:f.candidate.sourceSha});
    // Retained history could predate the promotion guard. Inject only that old
    // canonical fact; candidate verification must still consult the real DB.
    await f.db.executor.insertInto("host_bundle_release_channels").values({channel:"dev",version:f.candidate.hostBundleVersion,promoted_at:new Date(PAIR_NOW).toISOString()}).execute();
    await expect(verifyPreviewPairCandidate(proof.input,proof.expected,source,f.config,PAIR_NOW)).rejects.toThrow("unavailable");
  });
  it("stages the new controller run atomically with an explicit clean reset",async () => {
    const candidate={...f.candidate,browserOrigin:f.candidate.browserOrigin.replace("-g1-","-g2-"),apiOrigin:f.candidate.apiOrigin.replace("-g1-","-g2-"),sourceSha:"d".repeat(40),platformSource:{kind:"candidate" as const,sha:"d".repeat(40)}};
    await requestPreviewPairUpdate(f.db,f.pair.pair_id,1,1,candidate,PAIR_NOW,789);
    const g=await f.db.executor.selectFrom("preview_pair_generations").selectAll().where("generation","=",2).executeTakeFirstOrThrow();
    expect(g.controller_run_id).toBe("789");
  });
});
