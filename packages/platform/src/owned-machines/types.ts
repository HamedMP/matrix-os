import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type OwnedTunnelState = 'pending' | 'ready' | 'reclaimed' | 'deleting' | 'deleted' | 'failed';
export type OwnedEnrollmentStatus = 'pending' | 'approved' | 'delivered' | 'denied' | 'expired';

export interface OwnedMachineLinksTable {
  machine_id: string;
  clerk_user_id: string;
  display_name: string;
  tunnel_state: Generated<OwnedTunnelState>;
  tunnel_id: string | null;
  tunnel_hostname: string | null;
  tunnel_attempts: Generated<number>;
  tunnel_next_attempt_at: Timestamp;
  reported_hostname: string | null;
  reported_os: string | null;
  reported_arch: 'x86_64' | 'arm64' | null;
  agent_version: string | null;
  last_heartbeat_at: NullableTimestamp;
  auto_security_updates: Generated<boolean>;
  backups_enabled: Generated<boolean>;
  paired_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface OwnedMachineEnrollmentsTable {
  enrollment_id: string;
  device_code_hash: string;
  user_code: string;
  status: Generated<OwnedEnrollmentStatus>;
  reported_hostname: string;
  reported_os: string;
  reported_arch: 'x86_64' | 'arm64';
  agent_version: string;
  source_key: string;
  clerk_user_id: string | null;
  machine_id: string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  approved_at: NullableTimestamp;
  delivered_at: NullableTimestamp;
  last_polled_at: NullableTimestamp;
}
