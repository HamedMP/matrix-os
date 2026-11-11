import {
  CollaborativeAppManifestDeclarationSchema,
  CollaborativeAppReadinessGateResultSchema,
  type CollaborativeAppBuildRef,
  type CollaborativeAppManifestDeclaration,
} from "@matrix-os/contracts";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "acorn";
import { z } from "zod/v4";

import type { ImmutableCollaborativeBuildStore } from "../app-runtime/build-cache.js";
import { inspectBehaviorSource } from "./collaborative-app-behavior.js";

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

const SUPPORTED_BRIDGE_CONTRACT_VERSION = "matrix-app-bridge-v1";
const SUPPORTED_RUNTIME_ABI = "matrix-runtime-v1";
const BEHAVIOR_SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const MAX_BEHAVIOR_FILES = 256;
const MAX_BEHAVIOR_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BEHAVIOR_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_BEHAVIOR_DEPTH = 16;

export interface CollaborativeAppBuildBehavior {
  sharedRead: boolean;
  revisionedWrite: boolean;
  changeSignal: boolean;
}

export interface CollaborativeAppBehaviorProbe {
  inspect(input: CollaborativeAppReadinessVerificationInput, signal: AbortSignal): Promise<CollaborativeAppBuildBehavior>;
}

/** Bounded inspection of the immutable built bytes, independent of the app's declaration. */
export class CollaborativeAppBuildBehaviorProbe implements CollaborativeAppBehaviorProbe {
  constructor(private readonly builds: Pick<ImmutableCollaborativeBuildStore, "resolve">) {}

  async inspect(
    input: CollaborativeAppReadinessVerificationInput,
    signal: AbortSignal,
  ): Promise<CollaborativeAppBuildBehavior> {
    signal.throwIfAborted();
    if (input.artifactRef !== `objects/${input.build.buildId}`) return missingBehavior();
    const snapshot = await this.builds.resolve(input.build.buildId);
    if (!snapshot) return missingBehavior();
    const root = await realpath(snapshot.artifactPath);
    let files = 0;
    let bytes = 0;
    let sharedRead = false;
    let revisionedWrite = false;
    let changeSignal = false;
    const seen = new Set<string>();
    const visitSource = async (source: string, from: string, depth: number): Promise<void> => {
      const detected = inspectBehaviorSource(source, signal);
      sharedRead ||= detected.sharedRead;
      revisionedWrite ||= detected.revisionedWrite;
      changeSignal ||= detected.changeSignal;
      for (const specifier of staticModuleImports(source)) await visitFile(specifier, from, depth + 1);
    };
    const visitFile = async (specifier: string, from: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > MAX_BEHAVIOR_DEPTH || files >= MAX_BEHAVIOR_FILES) throw new Error("Built app behavior inspection limit exceeded");
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) || specifier.startsWith("//")) return;
      const barePath = specifier.split(/[?#]/, 1)[0]!;
      const candidate = resolve(barePath.startsWith("/") ? root : dirname(from), barePath.replace(/^\//, ""));
      const candidateRelative = relative(root, candidate);
      if (candidateRelative.startsWith(`..${sep}`) || candidateRelative === ".." || isAbsolute(candidateRelative)) return;
      const path = await realpath(candidate);
      const pathRelative = relative(root, path);
      if (pathRelative.startsWith(`..${sep}`) || pathRelative === ".." || isAbsolute(pathRelative) || seen.has(path)) return;
      seen.add(path);
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_BEHAVIOR_FILE_BYTES || bytes + info.size > MAX_BEHAVIOR_TOTAL_BYTES) {
        throw new Error("Built app behavior inspection limit exceeded");
      }
      files += 1;
      bytes += info.size;
      const source = await readFile(path, "utf8");
      if (extname(path).toLowerCase() === ".html") {
        for (const script of extractExecutableScripts(source)) {
          if (script.src) await visitFile(script.src, path, depth + 1);
          else await visitSource(script.body, path, depth + 1);
        }
      } else if (BEHAVIOR_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
        await visitSource(source, path, depth + 1);
      }
    };
    await visitFile("index.html", join(root, "index.html"), 0);
    return {
      sharedRead,
      revisionedWrite,
      changeSignal,
    };
  }
}

function missingBehavior(): CollaborativeAppBuildBehavior {
  return { sharedRead: false, revisionedWrite: false, changeSignal: false };
}

function extractExecutableScripts(html: string): Array<{ body: string; src: string | null }> {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const scripts: Array<{ body: string; src: string | null }> = [];
  for (const match of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]!);
    const language = (type?.[1] ?? type?.[2] ?? type?.[3] ?? "text/javascript").toLowerCase();
    if (language === "module" || language === "text/javascript" || language === "application/javascript") {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]!);
      scripts.push({ body: match[2]!, src: src ? (src[1] ?? src[2] ?? src[3] ?? null) : null });
    }
  }
  return scripts;
}

function staticModuleImports(source: string): string[] {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  return program.body.flatMap((statement) => {
    if ((statement.type === "ImportDeclaration" || statement.type === "ExportAllDeclaration"
      || statement.type === "ExportNamedDeclaration") && statement.source?.value
      && typeof statement.source.value === "string") return [statement.source.value];
    return [];
  });
}

/**
 * V1 readiness proves the exact Matrix-managed capability path. The real
 * recipient remains the authenticated Matrix actor presented at launch; no
 * synthetic second credential or app-specific permission principal exists.
 */
export class CollaborativeAppCapabilityVerifier implements CollaborativeAppReadinessVerifier {
  constructor(private readonly behaviorProbe?: CollaborativeAppBehaviorProbe) {}

  async verify(input: CollaborativeAppReadinessVerificationInput, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const declaration = CollaborativeAppManifestDeclarationSchema.safeParse(input.declaration);
    const declared = declaration.success;
    const exactBuild = input.artifactRef === `objects/${input.build.buildId}`
      && input.build.bridgeContractVersion !== "undeclared"
      && input.build.runtimeAbi !== "undeclared";
    const buildMatchesDeclaration = declared
      && declaration.data.compatibility.bridgeContractVersion === input.build.bridgeContractVersion
      && declaration.data.compatibility.runtimeAbi === input.build.runtimeAbi
      && declaration.data.compatibility.schemaDigest === input.build.schemaDigest;
    const compatible = buildMatchesDeclaration
      && input.build.bridgeContractVersion === SUPPORTED_BRIDGE_CONTRACT_VERSION
      && input.build.runtimeAbi === SUPPORTED_RUNTIME_ABI;
    const behavior = compatible && this.behaviorProbe
      ? await this.behaviorProbe.inspect(input, signal)
      : missingBehavior();

    return [
      declared
        ? passed("declaration")
        : blocked("declaration", "Declare this app's collaborative capability and recheck."),
      exactBuild
        ? passed("exact_build")
        : blocked("exact_build", "Build the exact collaborative app version and recheck."),
      declared && compatible && behavior.sharedRead
        ? passed("owner_postgres")
        : blocked("owner_postgres", "Use shared owner-backed reads in the built app and recheck."),
      compatible
        ? passed("recipient_launch")
        : blocked("recipient_launch", "Update the app bridge compatibility and recheck."),
      declared
        ? passed("participant_identity")
        : blocked("participant_identity", "Use the authenticated Matrix participant identity and recheck."),
      declared && behavior.revisionedWrite
        ? passed("idempotent_retry")
        : blocked("idempotent_retry", "Use revisioned shared mutations in the built app and recheck."),
      declared && behavior.revisionedWrite
        ? passed("conflict_write")
        : blocked("conflict_write", "Use revisioned shared mutations in the built app and recheck."),
      declared && behavior.changeSignal
        ? passed("change_signal")
        : blocked("change_signal", "Subscribe to shared change signals in the built app and recheck."),
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
