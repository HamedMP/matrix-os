import type {
  AgentId,
  ApproveCapabilityResponse,
  IntegrationCapabilitySummary,
  IntegrationCapabilitiesResponse,
} from "./activation-contracts.js";
import { ActivationRouteError } from "./activation-errors.js";
import { SERVICE_REGISTRY } from "../integrations/registry.js";
import { atomicWriteJson, readJsonFile } from "../state-ops.js";

const MAX_OWNERS = 512;
const VALID_AGENTS = new Set<AgentId>(["claude", "codex", "hermes"]);

const LAUNCH_CAPABILITIES: IntegrationCapabilitySummary[] = [
  {
    id: "github.read_repository",
    provider: "github",
    capability: "read_repository",
    status: "connect_required",
    approvedAgents: [],
    requiresApprovalPerAction: true,
  },
  {
    id: "calendar.create_event",
    provider: "calendar",
    capability: "create_calendar_event",
    status: "connect_required",
    approvedAgents: [],
    requiresApprovalPerAction: true,
  },
  {
    id: "email.read_email",
    provider: "email",
    capability: "read_email",
    status: "connect_required",
    approvedAgents: [],
    requiresApprovalPerAction: true,
  },
];

export interface IntegrationCapabilityService {
  listCapabilities(ownerId: string): Promise<IntegrationCapabilitiesResponse>;
  getCapabilityApproval(ownerId: string, capabilityId: string): Promise<{ capabilityId: string; approvedAgents: AgentId[] } | null>;
  setApproval(ownerId: string, capabilityId: string, agent: AgentId, approved: boolean): Promise<ApproveCapabilityResponse>;
}

interface OwnerCapabilityState {
  approved: Record<string, AgentId[]>;
}

interface StoredIntegrationCapabilityState {
  version: 1;
  owners: Record<string, OwnerCapabilityState>;
}

function registryBackedCapabilities(connectedCapabilityIds: Set<string>): IntegrationCapabilitySummary[] {
  const registryHasGitHub = Boolean(SERVICE_REGISTRY.github);
  const registryHasCalendar = Boolean(SERVICE_REGISTRY.google_calendar);
  const registryHasEmail = Boolean(SERVICE_REGISTRY.gmail);
  return LAUNCH_CAPABILITIES
    .filter((capability) => {
      if (capability.provider === "github") return registryHasGitHub;
      if (capability.provider === "calendar") return registryHasCalendar;
      if (capability.provider === "email") return registryHasEmail;
      return true;
    })
    .map((capability) => ({
      ...capability,
      status: connectedCapabilityIds.has(capability.id) ? "connected" : capability.status,
      approvedAgents: [],
    }));
}

export function capabilityIdsForConnectedServices(serviceIds: Iterable<string>): string[] {
  const capabilities = new Set<string>();
  for (const serviceId of serviceIds) {
    if (serviceId === "github") capabilities.add("github.read_repository");
    if (serviceId === "google_calendar") capabilities.add("calendar.create_event");
    if (serviceId === "gmail") capabilities.add("email.read_email");
  }
  return Array.from(capabilities);
}

export function createIntegrationCapabilityService(options: {
  connectedCapabilityIds?: string[];
  getConnectedCapabilityIds?: (ownerId: string) => Promise<string[]>;
  onChange?: (ownerId: string) => void;
  storagePath?: string;
} = {}): IntegrationCapabilityService {
  const states = new Map<string, OwnerCapabilityState>();
  const ownerMutationQueues = new Map<string, Promise<unknown>>();
  const connectedCapabilityIds = new Set(options.connectedCapabilityIds ?? []);
  let persistQueue: Promise<void> = Promise.resolve();

  async function connectedCapabilitiesFor(ownerId: string): Promise<Set<string>> {
    const connected = new Set(connectedCapabilityIds);
    const dynamicConnected = await options.getConnectedCapabilityIds?.(ownerId);
    for (const capabilityId of dynamicConnected ?? []) connected.add(capabilityId);
    return connected;
  }

  function normalizeState(value: unknown): OwnerCapabilityState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const approved = (value as { approved?: unknown }).approved;
    if (!approved || typeof approved !== "object" || Array.isArray(approved)) return null;
    const next: OwnerCapabilityState = { approved: {} };
    for (const [capabilityId, agents] of Object.entries(approved)) {
      if (!LAUNCH_CAPABILITIES.some((capability) => capability.id === capabilityId) || !Array.isArray(agents)) continue;
      next.approved[capabilityId] = agents.filter((agent): agent is AgentId =>
        typeof agent === "string" && VALID_AGENTS.has(agent as AgentId)
      );
    }
    return next;
  }

  async function readStoredOwners(): Promise<Record<string, OwnerCapabilityState>> {
    if (!options.storagePath) return {};
    try {
      const stored = await readJsonFile<unknown>(options.storagePath);
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      const owners = (stored as { owners?: unknown }).owners;
      if (!owners || typeof owners !== "object" || Array.isArray(owners)) return {};
      const next: Record<string, OwnerCapabilityState> = {};
      for (const [ownerId, value] of Object.entries(owners)) {
        const state = normalizeState(value);
        if (state) next[ownerId] = state;
      }
      return next;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
      console.warn("[integrations] capability approval load failed:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function persistOwner(ownerId: string, state: OwnerCapabilityState | null): Promise<void> {
    if (!options.storagePath) return;
    const previousWrite = persistQueue.catch((err: unknown) => {
      console.warn("[integrations] previous capability approval persist failed:", err instanceof Error ? err.message : String(err));
    });
    const write = previousWrite.then(async () => {
      const owners = await readStoredOwners();
      if (state && Object.values(state.approved).some((agents) => agents.length > 0)) {
        owners[ownerId] = structuredClone(state);
      } else {
        delete owners[ownerId];
      }
      const stored: StoredIntegrationCapabilityState = { version: 1, owners };
      await atomicWriteJson(options.storagePath!, stored);
    });
    persistQueue = write.catch((err: unknown) => {
      console.warn("[integrations] capability approval persist failed:", err instanceof Error ? err.message : String(err));
    });
    await write;
  }

  function touchState(ownerId: string, state: OwnerCapabilityState): OwnerCapabilityState {
    states.delete(ownerId);
    if (states.size >= MAX_OWNERS) {
      const oldestKey = states.keys().next().value as string | undefined;
      if (oldestKey) states.delete(oldestKey);
    }
    states.set(ownerId, state);
    return state;
  }

  async function withOwnerMutation<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
    if (!ownerMutationQueues.has(ownerId) && ownerMutationQueues.size >= MAX_OWNERS) {
      throw new ActivationRouteError("capability_queue_busy", "Capability approvals are busy; try again", { status: 503, retryable: true });
    }
    const previous = ownerMutationQueues.get(ownerId) ?? Promise.resolve();
    const next = previous.catch((err: unknown) => {
      console.warn("[integrations] previous capability approval mutation failed:", err instanceof Error ? err.message : String(err));
    }).then(operation);
    const tracked = next.catch((err: unknown) => {
      console.warn("[integrations] capability approval mutation failed:", err instanceof Error ? err.message : String(err));
    });
    ownerMutationQueues.set(ownerId, tracked);
    try {
      return await next;
    } finally {
      if (ownerMutationQueues.get(ownerId) === tracked) ownerMutationQueues.delete(ownerId);
    }
  }

  async function findState(ownerId: string): Promise<OwnerCapabilityState | null> {
    const existing = states.get(ownerId);
    if (existing) return touchState(ownerId, existing);
    const stored = (await readStoredOwners())[ownerId];
    return stored ? ensureState(ownerId, stored) : null;
  }

  function ensureState(ownerId: string, initial?: OwnerCapabilityState): OwnerCapabilityState {
    const existing = states.get(ownerId);
    if (existing) return touchState(ownerId, existing);
    const next = initial ?? { approved: {} };
    return touchState(ownerId, next);
  }

  async function listCapabilities(ownerId: string): Promise<IntegrationCapabilitiesResponse> {
    const state = await findState(ownerId);
    const connected = await connectedCapabilitiesFor(ownerId);
    const capabilities = registryBackedCapabilities(connected).map((capability) => {
      const approvedAgents = capability.status === "connected" ? state?.approved[capability.id] ?? [] : [];
      return {
        ...capability,
        status: approvedAgents.length > 0 ? "approved" as const : capability.status,
        approvedAgents,
      };
    });
    return { capabilities };
  }

  async function getCapabilityApproval(ownerId: string, capabilityId: string): Promise<{ capabilityId: string; approvedAgents: AgentId[] } | null> {
    const connected = await connectedCapabilitiesFor(ownerId);
    const capability = registryBackedCapabilities(connected).find((candidate) => candidate.id === capabilityId);
    if (!capability) return null;
    if (!connected.has(capabilityId)) {
      return { capabilityId, approvedAgents: [] };
    }
    const state = await findState(ownerId);
    return {
      capabilityId,
      approvedAgents: state?.approved[capabilityId] ?? [],
    };
  }

  async function setApproval(ownerId: string, capabilityId: string, agent: AgentId, approved: boolean): Promise<ApproveCapabilityResponse> {
    const connected = await connectedCapabilitiesFor(ownerId);
    const capabilities = registryBackedCapabilities(connected);
    const capability = capabilities.find((candidate) => candidate.id === capabilityId);
    if (!capability) {
      throw new ActivationRouteError("capability_not_found", "Integration capability was not found", { status: 404 });
    }
    if (approved && capability.status === "connect_required") {
      throw new ActivationRouteError("capability_not_connected", "Connect the integration before approving agent access", { status: 409 });
    }
    return await withOwnerMutation(ownerId, async () => {
      // Keep the read -> clone -> persist -> touch sequence inside the per-owner
      // queue so concurrent approvals observe earlier writes before building nextState.
      const existing = await findState(ownerId);
      if (!approved && !existing) {
        return {
          capabilityId,
          agent,
          status: capability.status,
        };
      }
      const nextState: OwnerCapabilityState = { approved: { ...(existing?.approved ?? {}) } };
      const current = new Set(nextState.approved[capabilityId] ?? []);
      if (approved) current.add(agent);
      else current.delete(agent);
      const nextAgents = Array.from(current);
      if (nextAgents.length > 0) nextState.approved[capabilityId] = nextAgents;
      else delete nextState.approved[capabilityId];
      await persistOwner(ownerId, nextState);
      touchState(ownerId, nextState);
      const nextStatus = current.size > 0 && capability.status === "connected" ? "approved" : capability.status;
      options.onChange?.(ownerId);
      return {
        capabilityId,
        agent,
        status: nextStatus,
      };
    });
  }

  return { listCapabilities, getCapabilityApproval, setApproval };
}
