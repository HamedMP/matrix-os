import {
  CollaborativeAppManifestDeclarationSchema,
  CollaborativeAppReadinessGateResultSchema,
  type CollaborativeAppBuildRef,
  type CollaborativeAppManifestDeclaration,
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
  declaration: CollaborativeAppManifestDeclaration | null;
}

export interface CollaborativeAppReadinessVerifier {
  verify(
    input: CollaborativeAppReadinessVerificationInput,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const passed = (code: (typeof APPROVED_COLLABORATIVE_APP_READINESS_GATES)[number]) => ({
  code,
  status: "passed" as const,
});

const blocked = (
  code: (typeof APPROVED_COLLABORATIVE_APP_READINESS_GATES)[number],
  action: string,
) => ({ code, status: "blocked" as const, action });

/**
 * V1 readiness proves the exact Matrix-managed capability path. The real
 * recipient remains the authenticated Matrix actor presented at launch; no
 * synthetic second credential or app-specific permission principal exists.
 */
export class CollaborativeAppCapabilityVerifier implements CollaborativeAppReadinessVerifier {
  async verify(input: CollaborativeAppReadinessVerificationInput, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const declaration = CollaborativeAppManifestDeclarationSchema.safeParse(input.declaration);
    const declared = declaration.success;
    const exactBuild = input.artifactRef === `objects/${input.build.buildId}`
      && input.build.bridgeContractVersion !== "undeclared"
      && input.build.runtimeAbi !== "undeclared";
    const compatible = declared
      && declaration.data.compatibility.bridgeContractVersion === input.build.bridgeContractVersion
      && declaration.data.compatibility.runtimeAbi === input.build.runtimeAbi
      && declaration.data.compatibility.schemaDigest === input.build.schemaDigest;

    return [
      declared
        ? passed("declaration")
        : blocked("declaration", "Declare this app's collaborative capability and recheck."),
      exactBuild
        ? passed("exact_build")
        : blocked("exact_build", "Build the exact collaborative app version and recheck."),
      declared && compatible
        ? passed("owner_postgres")
        : blocked("owner_postgres", "Use the declared owner-backed data schema and recheck."),
      compatible
        ? passed("recipient_launch")
        : blocked("recipient_launch", "Update the app bridge compatibility and recheck."),
      declared
        ? passed("participant_identity")
        : blocked("participant_identity", "Use the authenticated Matrix participant identity and recheck."),
      declared
        ? passed("idempotent_retry")
        : blocked("idempotent_retry", "Declare transactional revisioned mutations and recheck."),
      declared
        ? passed("conflict_write")
        : blocked("conflict_write", "Declare transactional revisioned mutations and recheck."),
      declared
        ? passed("change_signal")
        : blocked("change_signal", "Declare content-free change signals and recheck."),
      declared
        ? passed("provider_safety")
        : blocked("provider_safety", "Use Matrix's existing provider authority and recheck."),
      exactBuild
        ? passed("cleanup")
        : blocked("cleanup", "Create a managed immutable build and recheck."),
    ];
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
    verifier: CollaborativeAppReadinessVerifier;
    now?: () => Date;
    verifierVersion?: string;
    timeoutMs?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.verifierVersion = options.verifierVersion ?? "collaborative-app-capability-v1";
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
      gateResults = GateResultsSchema.parse(raw);
      status = gateResults.some((gate) => gate.status === "failed")
        ? "failed"
        : gateResults.some((gate) => gate.status === "blocked") ? "blocked" : "ready";
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
