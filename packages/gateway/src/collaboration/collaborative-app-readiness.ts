import {
  CollaborativeAppManifestDeclarationSchema,
  CollaborativeAppReadinessGateResultSchema,
  type CollaborativeAppBuildRef,
  type CollaborativeAppManifestDeclaration,
} from "@matrix-os/contracts";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod/v4";

import type { ImmutableCollaborativeBuildStore } from "../app-runtime/build-cache.js";

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
const BEHAVIOR_SOURCE_EXTENSIONS = new Set([".cjs", ".html", ".js", ".mjs"]);
const MAX_BEHAVIOR_FILES = 256;
const MAX_BEHAVIOR_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BEHAVIOR_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_BEHAVIOR_DEPTH = 16;
const MAX_BEHAVIOR_ALIASES = 32;
const JS_IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]{0,127}";
const MATRIX_COLLABORATION_EXPRESSION = String.raw`(?:(?:window|globalThis)\s*(?:\?\.|\.)\s*)?MatrixOS(?:\?\.|\.)collaboration`;

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
    let files = 0;
    let bytes = 0;
    let sharedRead = false;
    let revisionedWrite = false;
    let changeSignal = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_BEHAVIOR_DEPTH || files >= MAX_BEHAVIOR_FILES || bytes >= MAX_BEHAVIOR_TOTAL_BYTES) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        signal.throwIfAborted();
        if (files >= MAX_BEHAVIOR_FILES || bytes >= MAX_BEHAVIOR_TOTAL_BYTES) break;
        if (entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        if (!info.isFile() || !BEHAVIOR_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())
          || info.size > MAX_BEHAVIOR_FILE_BYTES || bytes + info.size > MAX_BEHAVIOR_TOTAL_BYTES) continue;
        files += 1;
        bytes += info.size;
        const source = await readFile(path, "utf8");
        const executableSource = extname(entry.name).toLowerCase() === ".html"
          ? extractExecutableScripts(source)
          : source;
        const detected = inspectBehaviorSource(stripNonExecutableJavaScript(executableSource));
        sharedRead ||= detected.sharedRead;
        revisionedWrite ||= detected.revisionedWrite;
        changeSignal ||= detected.changeSignal;
      }
    };
    await visit(snapshot.artifactPath, 0);
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

function extractExecutableScripts(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const scripts: string[] = [];
  for (const match of withoutComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]!);
    const language = (type?.[1] ?? type?.[2] ?? type?.[3] ?? "text/javascript").toLowerCase();
    if (language === "module" || language === "text/javascript" || language === "application/javascript") {
      scripts.push(match[2]!);
    }
  }
  return scripts.join("\n");
}

/** Remove comments and literal text before looking for executable bridge calls. */
function stripNonExecutableJavaScript(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (current === "/" && (next === "/" || next === "*")) {
      const line = next === "/";
      index += 2;
      while (index < source.length && (line ? source[index] !== "\n" : !(source[index] === "*" && source[index + 1] === "/"))) index++;
      if (!line && index < source.length) index += 2;
      result += " ";
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      index++;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index++] === quote) break;
      }
      result += " ";
      continue;
    }
    result += current;
    index++;
  }
  return result;
}

function inspectBehaviorSource(source: string): CollaborativeAppBuildBehavior {
  const bases = [MATRIX_COLLABORATION_EXPRESSION];
  const aliasPattern = new RegExp(
    String.raw`\b(?:const|let|var)\s+(${JS_IDENTIFIER})\s*=\s*${MATRIX_COLLABORATION_EXPRESSION}`,
    "g",
  );
  for (const match of source.matchAll(aliasPattern)) {
    if (bases.length > MAX_BEHAVIOR_ALIASES) break;
    bases.push(match[1]!);
  }

  const localMethods: Array<{ method: "query" | "mutate" | "onChange"; local: string }> = [];
  for (const base of bases) {
    const destructuring = new RegExp(
      String.raw`\b(?:const|let|var)\s*\{([^{}]{1,512})\}\s*=\s*(?:${base})(?![A-Za-z0-9_$])`,
      "g",
    );
    for (const match of source.matchAll(destructuring)) {
      for (const part of match[1]!.split(",")) {
        if (localMethods.length >= MAX_BEHAVIOR_ALIASES) break;
        const binding = /^\s*(query|mutate|onChange)(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]{0,127}))?\s*$/.exec(part);
        if (binding) localMethods.push({
          method: binding[1] as "query" | "mutate" | "onChange",
          local: binding[2] ?? binding[1]!,
        });
      }
    }
  }

  const calledProperty = (method: "query" | "mutate" | "onChange") => bases.some((base) => new RegExp(
    String.raw`(?:${base})(?:\?\.|\.)${method}\s*(?:\?\.)?\(`,
  ).test(source));
  const calledLocal = (method: "query" | "mutate" | "onChange") => localMethods.some((binding) =>
    binding.method === method && new RegExp(String.raw`(?:^|[^A-Za-z0-9_$])${binding.local}\s*(?:\?\.)?\(`).test(source));

  return {
    sharedRead: calledProperty("query") || calledLocal("query"),
    revisionedWrite: calledProperty("mutate") || calledLocal("mutate"),
    changeSignal: calledProperty("onChange") || calledLocal("onChange"),
  };
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
