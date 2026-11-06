import {z} from "zod/v4";
import type {PlatformDB} from "../db.js";
import {getHostBundleRelease} from "../db.js";
import type {createPreviewPairGitHub} from "./github.js";
import type {PreviewPairProvenanceSource} from "./provenance.js";
/** Canonical DB and authenticated provider readers; no candidate-supplied source facts. */
export function createPreviewPairSources(db:PlatformDB,github:Pick<ReturnType<typeof createPreviewPairGitHub>,"pullRequest"|"artifact"|"build"|"buildSource"|"controllerProof">,
  authority:PreviewPairProvenanceSource["authority"]):PreviewPairProvenanceSource {
  return {pullRequest:github.pullRequest,artifact:github.artifact,build:github.build,
    buildSource:github.buildSource,controllerProof:github.controllerProof,authority,
    async hostRelease(version:string){
      z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).parse(version);
      const [release,channels]=await Promise.all([getHostBundleRelease(db,version),
        db.executor.selectFrom("host_bundle_release_channels").select("channel").where("version","=",version).limit(8).execute()]);
      return {release,promotedChannels:channels.map(row=>row.channel)};
    },
  };
}
