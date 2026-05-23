import type {
  OnboardingGoalId,
  ReadinessGateId,
  ReadinessGateStatus,
} from "./activation-contracts.js";

export interface ReadinessGateOverride {
  status: ReadinessGateStatus;
  message?: string;
  remediation?: string | null;
  lastCheckedAt?: string | null;
  evidence?: string[];
}

export interface OnboardingReadinessRecord {
  ownerId: string;
  selectedGoalIds: OnboardingGoalId[];
  completedStepIds: string[];
  skippedStepIds: string[];
  gateOverrides: Record<ReadinessGateId, ReadinessGateOverride>;
  updatedAt: string;
}

export interface ReadinessRepository {
  get(ownerId: string): Promise<OnboardingReadinessRecord | null>;
  save(record: OnboardingReadinessRecord): Promise<OnboardingReadinessRecord>;
}

export class InMemoryReadinessRepository implements ReadinessRepository {
  private readonly records = new Map<string, OnboardingReadinessRecord>();

  async get(ownerId: string): Promise<OnboardingReadinessRecord | null> {
    const record = this.records.get(ownerId);
    return record ? structuredClone(record) : null;
  }

  async save(record: OnboardingReadinessRecord): Promise<OnboardingReadinessRecord> {
    const cloned = structuredClone(record);
    this.records.set(record.ownerId, cloned);
    return structuredClone(cloned);
  }
}

