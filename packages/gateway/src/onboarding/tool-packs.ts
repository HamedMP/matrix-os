import { spawn } from "node:child_process";
import type {
  ToolPackId,
  ToolPackInstallJobSummary,
  ToolPackSummary,
  ToolPacksResponse,
} from "./activation-contracts.js";

interface ToolPackDefinition {
  id: ToolPackId;
  category: ToolPackSummary["category"];
  label: string;
  description: string;
  commands: string[];
  defaultSelected: boolean;
}

const TOOL_PACKS: ToolPackDefinition[] = [
  {
    id: "hermes",
    category: "agent",
    label: "Hermes",
    description: "Matrix system agent, bundled Matrix skills, and Hermes runtime setup.",
    commands: ["hermes", "uv", "uvx"],
    defaultSelected: true,
  },
  {
    id: "coding-agents",
    category: "agent",
    label: "Coding agents",
    description: "Claude Code, Codex, OpenCode, and Pi command-line coding agents.",
    commands: ["claude", "codex", "opencode", "pi"],
    defaultSelected: false,
  },
  {
    id: "code-server",
    category: "editor",
    label: "Browser editor",
    description: "code-server for the browser-based editor path on the owner VPS.",
    commands: ["code-server"],
    defaultSelected: false,
  },
  {
    id: "linux-tools",
    category: "system",
    label: "Linux developer tools",
    description: "Homebrew, Graphite, GitHub CLI, and build tools for local workflow polish.",
    commands: ["brew", "gt", "gh"],
    defaultSelected: false,
  },
];

const DEFAULT_SELECTED_PACK_IDS = TOOL_PACKS
  .filter((pack) => pack.defaultSelected)
  .map((pack) => pack.id);
const MAX_TOOL_PACK_RECORDS = 512;
const MAX_INSTALL_JOBS_PER_OWNER = 64;
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_INSTALL_OUTPUT_BYTES = 16_384;

export interface ToolPackRecord {
  ownerId: string;
  selectedPackIds: ToolPackId[];
  installJobs: ToolPackInstallJobSummary[];
  updatedAt: string;
}

export interface ToolPackRepository {
  get(ownerId: string): Promise<ToolPackRecord | null>;
  save(record: ToolPackRecord): Promise<ToolPackRecord>;
  update(ownerId: string, updater: (record: ToolPackRecord | null) => ToolPackRecord): Promise<ToolPackRecord>;
}

export interface ToolPackInstaller {
  install(ownerId: string, packId: ToolPackId): Promise<void>;
}

export interface ToolPackService {
  listToolPacks(ownerId: string): Promise<ToolPacksResponse>;
  selectToolPacks(ownerId: string, packIds: ToolPackId[]): Promise<ToolPacksResponse>;
  installToolPacks(ownerId: string, packIds: ToolPackId[]): Promise<ToolPacksResponse>;
}

export class InMemoryToolPackRepository implements ToolPackRepository {
  private readonly records = new Map<string, ToolPackRecord>();

  async get(ownerId: string): Promise<ToolPackRecord | null> {
    const record = this.records.get(ownerId);
    if (record) {
      this.records.delete(ownerId);
      this.records.set(ownerId, record);
    }
    return record ? structuredClone(record) : null;
  }

  async save(record: ToolPackRecord): Promise<ToolPackRecord> {
    const cloned = structuredClone(record);
    if (!this.records.has(record.ownerId) && this.records.size >= MAX_TOOL_PACK_RECORDS) {
      const oldestKey = this.records.keys().next().value as string | undefined;
      if (oldestKey) this.records.delete(oldestKey);
    }
    this.records.delete(record.ownerId);
    this.records.set(record.ownerId, cloned);
    return structuredClone(cloned);
  }

  async update(ownerId: string, updater: (record: ToolPackRecord | null) => ToolPackRecord): Promise<ToolPackRecord> {
    const current = this.records.get(ownerId) ?? null;
    const next = updater(current ? structuredClone(current) : null);
    if (next.ownerId !== ownerId) {
      throw new Error("Tool pack repository update cannot change ownerId");
    }
    return this.save(next);
  }
}

export function createHostToolPackInstaller(options: {
  scriptPath?: string;
  timeoutMs?: number;
} = {}): ToolPackInstaller {
  const scriptPath = options.scriptPath ?? "/opt/matrix/bin/matrix-install-tool-pack";
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

  return {
    install: async (ownerId, packId) => {
      await runHostInstaller(scriptPath, ownerId, packId, timeoutMs);
    },
  };
}

export function createToolPackService(options: {
  repository: ToolPackRepository;
  installer?: ToolPackInstaller;
  installTimeoutMs?: number;
  now?: () => Date;
}): ToolPackService {
  const now = options.now ?? (() => new Date());
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  let jobCounter = 0;

  function createEmptyRecord(ownerId: string): ToolPackRecord {
    return {
      ownerId,
      selectedPackIds: [...DEFAULT_SELECTED_PACK_IDS],
      installJobs: [],
      updatedAt: now().toISOString(),
    };
  }

  async function ensureRecord(ownerId: string): Promise<ToolPackRecord> {
    return options.repository.update(ownerId, (record) => record ?? createEmptyRecord(ownerId));
  }

  function uniquePackIds(packIds: ToolPackId[]): ToolPackId[] {
    return Array.from(new Set(packIds));
  }

  function normalizeJob(job: ToolPackInstallJobSummary): ToolPackInstallJobSummary {
    if (job.status !== "installing") return job;
    const startedAtMs = Date.parse(job.startedAt);
    if (!Number.isFinite(startedAtMs) || now().getTime() - startedAtMs <= installTimeoutMs) return job;
    return {
      ...job,
      status: "failed",
      completedAt: now().toISOString(),
      message: "Install status unavailable",
    };
  }

  function latestJobForPack(
    installJobs: ToolPackInstallJobSummary[],
    packId: ToolPackId,
  ): ToolPackInstallJobSummary | null {
    const packJobs = installJobs.filter((job) => job.packId === packId);
    const installingJob = packJobs.find((job) => job.status === "installing");
    if (installingJob) return installingJob;
    return packJobs.toSorted((left, right) => {
      const leftTime = Date.parse(left.completedAt ?? left.startedAt);
      const rightTime = Date.parse(right.completedAt ?? right.startedAt);
      return rightTime - leftTime;
    })[0] ?? null;
  }

  function responseFor(record: ToolPackRecord): ToolPacksResponse {
    const selected = new Set(record.selectedPackIds);
    const installJobs = record.installJobs.map(normalizeJob);
    const packs = TOOL_PACKS.map<ToolPackSummary>((pack) => {
      const latestJob = latestJobForPack(installJobs, pack.id);
      const installed = installJobs.some((job) => job.packId === pack.id && job.status === "installed");
      const selectedPack = selected.has(pack.id);
      return {
        ...pack,
        selected: selectedPack,
        installed,
        status: latestJob?.status ?? (selectedPack ? "selected" : "available"),
        installJobId: latestJob?.id ?? null,
      };
    });
    return {
      packs,
      selectedPackIds: [...record.selectedPackIds],
      installJobs,
    };
  }

  async function listToolPacks(ownerId: string): Promise<ToolPacksResponse> {
    return responseFor(await ensureRecord(ownerId));
  }

  async function selectToolPacks(ownerId: string, packIds: ToolPackId[]): Promise<ToolPacksResponse> {
    const selectedPackIds = uniquePackIds(packIds);
    const record = await options.repository.update(ownerId, (current) => ({
      ...(current ?? createEmptyRecord(ownerId)),
      selectedPackIds,
      updatedAt: now().toISOString(),
    }));
    return responseFor(record);
  }

  async function markJob(
    ownerId: string,
    jobId: string,
    status: ToolPackInstallJobSummary["status"],
    message: string | null,
  ): Promise<void> {
    await options.repository.update(ownerId, (current) => {
      const record = current ?? createEmptyRecord(ownerId);
      return {
        ...record,
        installJobs: record.installJobs.map((job) => job.id === jobId
          ? { ...job, status, completedAt: now().toISOString(), message }
          : job),
        updatedAt: now().toISOString(),
      };
    });
  }

  async function safelyMarkJob(
    ownerId: string,
    jobId: string,
    status: ToolPackInstallJobSummary["status"],
    message: string | null,
  ): Promise<void> {
    try {
      await markJob(ownerId, jobId, status, message);
    } catch (err: unknown) {
      console.warn("[onboarding] tool pack job status update failed:", err instanceof Error ? err.message : String(err));
    }
  }

  function runInstall(ownerId: string, job: ToolPackInstallJobSummary): void {
    void (async () => {
      try {
        if (!options.installer) {
          throw new Error("Tool pack installer is unavailable");
        }
        await options.installer.install(ownerId, job.packId);
        await safelyMarkJob(ownerId, job.id, "installed", "Installed");
      } catch (err: unknown) {
        console.warn("[onboarding] tool pack install failed:", err instanceof Error ? err.message : String(err));
        await safelyMarkJob(ownerId, job.id, "failed", "Install failed");
      }
    })();
  }

  async function installToolPacks(ownerId: string, packIds: ToolPackId[]): Promise<ToolPacksResponse> {
    const requestedPackIds = uniquePackIds(packIds);
    let createdJobs: ToolPackInstallJobSummary[] = [];
    const record = await options.repository.update(ownerId, (current) => {
      const base = current ?? createEmptyRecord(ownerId);
      const selectedPackIds = uniquePackIds([...base.selectedPackIds, ...requestedPackIds]);
      const activePackIds = new Set(
        base.installJobs
          .map(normalizeJob)
          .filter((job) => job.status === "installing")
          .map((job) => job.packId),
      );
      createdJobs = requestedPackIds
        .filter((packId) => !activePackIds.has(packId))
        .map((packId) => ({
          id: `tool-pack-${packId}-${Date.now()}-${jobCounter += 1}`,
          packId,
          status: "installing",
          startedAt: now().toISOString(),
          completedAt: null,
          message: null,
        }));
      return {
        ...base,
        selectedPackIds,
        installJobs: [...base.installJobs, ...createdJobs].slice(-MAX_INSTALL_JOBS_PER_OWNER),
        updatedAt: now().toISOString(),
      };
    });
    for (const job of createdJobs) runInstall(ownerId, job);
    return responseFor(record);
  }

  return { listToolPacks, selectToolPacks, installToolPacks };
}

async function runHostInstaller(
  scriptPath: string,
  ownerId: string,
  packId: ToolPackId,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(scriptPath, [packId], {
      env: {
        ...process.env,
        MATRIX_TOOL_PACK_OWNER_ID: ownerId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputTail = "";
    const appendOutput = (chunk: Buffer) => {
      outputTail = `${outputTail}${chunk.toString("utf8")}`.slice(-MAX_INSTALL_OUTPUT_BYTES);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`tool pack install timed out for ${packId}`));
    }, timeoutMs);
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tool pack install failed for ${packId} with exit code ${code}; ${outputTail}`));
    });
  });
}
