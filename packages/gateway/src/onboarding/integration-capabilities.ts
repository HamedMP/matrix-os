import type {
  AgentId,
  ApproveCapabilityResponse,
  IntegrationCapabilitySummary,
  IntegrationCapabilitiesResponse,
} from "./activation-contracts.js";
import { ActivationRouteError } from "./activation-errors.js";
import { SERVICE_REGISTRY } from "../integrations/registry.js";

const MAX_OWNERS = 512;

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
} = {}): IntegrationCapabilityService {
  const states = new Map<string, OwnerCapabilityState>();
  const ownerMutationQueues = new Map<string, Promise<unknown>>();
  const connectedCapabilityIds = new Set(options.connectedCapabilityIds ?? []);

  async function connectedCapabilitiesFor(ownerId: string): Promise<Set<string>> {
    const connected = new Set(connectedCapabilityIds);
    const dynamicConnected = await options.getConnectedCapabilityIds?.(ownerId);
    for (const capabilityId of dynamicConnected ?? []) connected.add(capabilityId);
    return connected;
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
    const previous = ownerMutationQueues.get(ownerId) ?? Promise.resolve();
    const next = previous.catch((err: unknown) => {
      console.warn("[integrations] previous capability approval mutation failed:", err instanceof Error ? err.message : String(err));
    }).then(operation);
    const tracked = next.catch((err: unknown) => {
      console.warn("[integrations] capability approval mutation failed:", err instanceof Error ? err.message : String(err));
    });
    ownerMutationQueues.delete(ownerId);
    if (ownerMutationQueues.size >= MAX_OWNERS) {
      const oldestKey = ownerMutationQueues.keys().next().value as string | undefined;
      if (oldestKey) ownerMutationQueues.delete(oldestKey);
    }
    ownerMutationQueues.set(ownerId, tracked);
    try {
      return await next;
    } finally {
      if (ownerMutationQueues.get(ownerId) === tracked) ownerMutationQueues.delete(ownerId);
    }
  }

  function findState(ownerId: string): OwnerCapabilityState | null {
    const existing = states.get(ownerId);
    return existing ? touchState(ownerId, existing) : null;
  }

  function ensureState(ownerId: string): OwnerCapabilityState {
    const existing = states.get(ownerId);
    if (existing) return touchState(ownerId, existing);
    const next = { approved: {} };
    return touchState(ownerId, next);
  }

  async function listCapabilities(ownerId: string): Promise<IntegrationCapabilitiesResponse> {
    const state = findState(ownerId);
    const connected = await connectedCapabilitiesFor(ownerId);
    const capabilities = registryBackedCapabilities(connected).map((capability) => {
      const approvedAgents = capability.status === "connected" ? state?.approved[capability.id] ?? [] : [];
      if (state && capability.status !== "connected" && state.approved[capability.id]?.length) {
        state.approved[capability.id] = [];
      }
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
    const state = await findState(ownerId);
    return {
      capabilityId,
      approvedAgents: capability.status === "connected" ? state?.approved[capabilityId] ?? [] : [],
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
    const state = ensureState(ownerId);
    const current = new Set(state.approved[capabilityId] ?? []);
    if (approved) current.add(agent);
    else current.delete(agent);
    state.approved[capabilityId] = Array.from(current);
    const nextStatus = current.size > 0 && capability.status === "connected" ? "approved" : capability.status;
    options.onChange?.(ownerId);
    return {
      capabilityId,
      agent,
      status: nextStatus,
    };
  }

  return { listCapabilities, getCapabilityApproval, setApproval };
}
