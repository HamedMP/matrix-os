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
  update(
    ownerId: string,
    updater: (record: OnboardingReadinessRecord | null) => OnboardingReadinessRecord,
  ): Promise<OnboardingReadinessRecord>;
}

const MAX_READINESS_RECORDS = 512;

export class InMemoryReadinessRepository implements ReadinessRepository {
  private readonly records = new Map<string, OnboardingReadinessRecord>();

  async get(ownerId: string): Promise<OnboardingReadinessRecord | null> {
    const record = this.records.get(ownerId);
    if (record) {
      this.records.delete(ownerId);
      this.records.set(ownerId, record);
    }
    return record ? structuredClone(record) : null;
  }

  async save(record: OnboardingReadinessRecord): Promise<OnboardingReadinessRecord> {
    const cloned = structuredClone(record);
    if (!this.records.has(record.ownerId) && this.records.size >= MAX_READINESS_RECORDS) {
      const oldestKey = this.records.keys().next().value as string | undefined;
      if (oldestKey) this.records.delete(oldestKey);
    }
    this.records.delete(record.ownerId);
    this.records.set(record.ownerId, cloned);
    return structuredClone(cloned);
  }

  async update(
    ownerId: string,
    updater: (record: OnboardingReadinessRecord | null) => OnboardingReadinessRecord,
  ): Promise<OnboardingReadinessRecord> {
    const current = this.records.get(ownerId) ?? null;
    const next = updater(current ? structuredClone(current) : null);
    if (next.ownerId !== ownerId) {
      throw new Error("Readiness repository update cannot change ownerId");
    }
    return this.save(next);
  }
}
