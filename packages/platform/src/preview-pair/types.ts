import type { Generated, JSONColumnType } from "kysely";
import type { PreviewPairRole, PreviewPairState } from "@matrix-os/contracts/preview-pair";

type JsonRecord = JSONColumnType<Record<string, unknown> | null, string | null, string | null>;

export interface PreviewPairsTable {
  pair_id: string;
  repository: string;
  pr: number;
  requester_id: string;
  source_sha: string;
  generation: Generated<number>;
  revision: Generated<number>;
  state: Generated<PreviewPairState>;
  outdated: Generated<boolean>;
  fixture_id: Generated<string | null>;
  created_at: string;
  expires_at: string;
  requested_source_sha: Generated<string | null>;
  failure_code: Generated<string | null>;
  claim_id: Generated<string | null>;
  claim_expires_at: Generated<string | null>;
  attempt: Generated<number>;
  next_attempt_at: Generated<string | null>;
  stopped_at: Generated<string | null>;
}

export interface PreviewPairFixturesTable {
  fixture_id: string;
  owner_actor_id: string;
  member_actor_id: string;
  outsider_actor_id: string;
  organization_id: string;
  active_pair_id: Generated<string | null>;
  revision: Generated<number>;
}

export interface PreviewPairGenerationsTable {
  pair_id: string;
  generation: number;
  source_sha: string;
  candidate: JsonRecord;
  data_policy: Generated<"reset">;
  created_at: string;
  ready_at: Generated<string | null>;
  retired_at: Generated<string | null>;
}

export interface PreviewPairMembersTable {
  pair_id: string;
  generation: number;
  role: PreviewPairRole;
  actor_id: string;
  machine_id: string;
  job_id: string;
  handle: string;
  observation: JsonRecord;
  retired_at: Generated<string | null>;
  provider_absent_at: Generated<string | null>;
}
