import {
  CollaborativeAppReadinessGateResultSchema,
  type CollaborativeAppBuildRef,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

import {
  CollaborativeAppReadinessRepositoryError,
  type CollaborativeAppReadinessRecord,
  type CollaborativeAppReadinessRepository,
} from "./collaborative-app-readiness-repository.js";

export const APPROVED_COLLABORATIVE_APP_READINESS_GATES = [
  "declaration",
  "exact_build",
  "owner_postgres",
  "recipient_launch",
  "participant_identity",
  "two_principal_round_trip",
  "idempotent_retry",
  "conflict_write",
  "change_signal",
  "provider_safety",
  "cleanup",
] as const;

const GateResultsSchema = z.array(CollaborativeAppReadinessGateResultSchema).min(1).max(12)
  .superRefine((results, context) => {
    const observed = new Set(results.map((result) => result.code));
    if (observed.size !== results.length
      || APPROVED_COLLABORATIVE_APP_READINESS_GATES.some((gate) => !observed.has(gate))) {
      context.addIssue({ code: "custom", message: "The production readiness proof is incomplete" });
    }
  });

export interface CollaborativeAppReadinessVerificationInput {
  ownerId: string;
  organizationId: string;
  build: CollaborativeAppBuildRef;
  artifactRef: string;
}

export interface CollaborativeAppSecondPrincipalVerifier {
  readonly approval: "approved" | "unconfigured";
  verify(
    input: CollaborativeAppReadinessVerificationInput,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export class UnconfiguredSecondPrincipalVerifier implements CollaborativeAppSecondPrincipalVerifier {
  readonly approval = "unconfigured" as const;

  async verify(): Promise<unknown> {
    return [{
      code: "two_principal_round_trip",
      status: "blocked",
      action: "A second authenticated verifier is not configured yet.",
    }];
  }
}

const genericFailure = [{
  code: "cleanup" as const,
  status: "failed" as const,
  action: "Readiness could not be verified. Try again.",
}];

export class CollaborativeAppReadinessEvaluator {
  private readonly now: () => Date;
  private readonly verifierVersion: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    repository: CollaborativeAppReadinessRepository;
    verifier: CollaborativeAppSecondPrincipalVerifier;
    now?: () => Date;
    verifierVersion?: string;
    timeoutMs?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.verifierVersion = options.verifierVersion ?? "collaborative-app-v1";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async check(input: CollaborativeAppReadinessVerificationInput): Promise<CollaborativeAppReadinessRecord> {
    let record = await this.options.repository.createOrGet({
      ownerId: input.ownerId,
      build: input.build,
      artifactRef: input.artifactRef,
      verifierVersion: this.verifierVersion,
    });
    if (record.status === "stale" || record.status === "failed") {
      try {
        record = await this.options.repository.restart({
          id: record.id,
          ownerId: input.ownerId,
          expectedRevision: record.revision,
        });
      } catch (error: unknown) {
        if (error instanceof CollaborativeAppReadinessRepositoryError && error.code === "conflict") {
          const current = await this.options.repository.get({ id: record.id, ownerId: input.ownerId });
          if (current) return current;
        }
        throw error;
      }
    }
    if (record.status !== "checking") return record;

    let status: "ready" | "blocked" | "failed";
    let gateResults: z.infer<typeof GateResultsSchema>;
    try {
      const raw = await this.options.verifier.verify(input, AbortSignal.timeout(this.timeoutMs));
      if (this.options.verifier.approval === "unconfigured") {
        gateResults = z.array(CollaborativeAppReadinessGateResultSchema).length(1).parse(raw);
        status = "blocked";
      } else {
        gateResults = GateResultsSchema.parse(raw);
        status = gateResults.some((gate) => gate.status === "failed")
          ? "failed"
          : gateResults.some((gate) => gate.status === "blocked") ? "blocked" : "ready";
      }
    } catch (error: unknown) {
      console.warn("[collaborative-app-readiness] verification failed", error instanceof Error ? error.name : "UnknownError");
      status = "failed";
      gateResults = genericFailure;
    }

    const verifiedAt = status === "ready" ? this.now() : undefined;
    try {
      return await this.options.repository.transition({
        id: record.id,
        ownerId: input.ownerId,
        expectedRevision: record.revision,
        status,
        gateResults,
        ...(verifiedAt ? { verifiedAt } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof CollaborativeAppReadinessRepositoryError && error.code === "conflict") {
        const current = await this.options.repository.get({ id: record.id, ownerId: input.ownerId });
        if (current) return current;
      }
      throw error;
    }
  }
}
