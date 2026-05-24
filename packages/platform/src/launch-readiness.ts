import type { PlatformDB } from './db.js';
import { getHostBundleReleaseByChannel } from './db.js';

export type LaunchReadinessStatus = 'pass' | 'fail';
export type LaunchReadinessOverallStatus = 'ready' | 'blocked';
export type LaunchReadinessOwner = 'operator' | 'matrix';
export type LaunchReadinessCategory =
  | 'activation'
  | 'provisioning'
  | 'shell'
  | 'ux'
  | 'agent'
  | 'coding'
  | 'integration'
  | 'company_brain'
  | 'support_growth'
  | 'admin'
  | 'entitlement';

export interface LaunchReadinessGate {
  id: string;
  category: LaunchReadinessCategory;
  criticality: 'release_critical';
  status: LaunchReadinessStatus;
  owner: LaunchReadinessOwner;
  message: string;
  remediation: string | null;
  lastCheckedAt: string;
}

export interface LaunchReadinessEvidence {
  promotedRelease: boolean;
  freshWorkspace: boolean;
  existingWorkspace: boolean;
  shellRouting: boolean;
  onboardingEducation: boolean;
  visualQa: boolean;
  integrations: boolean;
  hermesContinuity: boolean;
  agentExecution: boolean;
  codingHandoff: boolean;
  companyBrain: boolean;
  supportGrowth: boolean;
  adminControlSurface: boolean;
  entitlementGate: boolean;
}

export interface LaunchReadinessReport {
  generatedAt: string;
  launchReady: boolean;
  overallStatus: LaunchReadinessOverallStatus;
  gates: LaunchReadinessGate[];
}

export interface LaunchReadinessService {
  getReport(): Promise<LaunchReadinessReport>;
}

export interface LaunchReadinessServiceOptions {
  now?: () => Date;
  loadEvidence: () => Promise<LaunchReadinessEvidence>;
}

interface GateDefinition {
  id: string;
  category: LaunchReadinessCategory;
  owner: LaunchReadinessOwner;
  passMessage: string;
  failMessage: string;
  remediation: string;
  evidenceKey: keyof LaunchReadinessEvidence;
}

const RELEASE_CRITICAL_GATES: GateDefinition[] = [
  {
    id: 'release.beta_channel',
    category: 'activation',
    owner: 'operator',
    passMessage: 'Beta channel has a promoted host bundle release.',
    failMessage: 'Beta channel does not have a promoted host bundle release.',
    remediation: 'Promote a verified host bundle release to the beta channel.',
    evidenceKey: 'promotedRelease',
  },
  {
    id: 'workspace.fresh_rehearsal',
    category: 'provisioning',
    owner: 'operator',
    passMessage: 'Fresh workspace rehearsal has passed.',
    failMessage: 'Fresh workspace rehearsal has not passed.',
    remediation: 'Run the fresh-founder workspace rehearsal end to end.',
    evidenceKey: 'freshWorkspace',
  },
  {
    id: 'workspace.existing_rehearsal',
    category: 'provisioning',
    owner: 'operator',
    passMessage: 'Existing workspace rehearsal has passed.',
    failMessage: 'Existing workspace rehearsal has not passed.',
    remediation: 'Run the existing-workspace upgrade rehearsal and verify owner data remains intact.',
    evidenceKey: 'existingWorkspace',
  },
  {
    id: 'shell.routing',
    category: 'shell',
    owner: 'matrix',
    passMessage: 'Shell routing and VPS reachability have passed.',
    failMessage: 'Shell routing or VPS reachability has not passed.',
    remediation: 'Verify app/code/profile routing against a running customer VPS.',
    evidenceKey: 'shellRouting',
  },
  {
    id: 'onboarding.education',
    category: 'ux',
    owner: 'matrix',
    passMessage: 'Onboarding education explains Matrix capabilities before setup.',
    failMessage: 'Onboarding education has not passed.',
    remediation: 'Verify the guided onboarding copy and goal-based setup path.',
    evidenceKey: 'onboardingEducation',
  },
  {
    id: 'onboarding.visual_qa',
    category: 'ux',
    owner: 'matrix',
    passMessage: 'Onboarding visual QA has passed.',
    failMessage: 'Onboarding visual QA has not passed.',
    remediation: 'Run desktop, mobile, reduced-motion, and missing-media onboarding visual QA.',
    evidenceKey: 'visualQa',
  },
  {
    id: 'integrations.approved_capabilities',
    category: 'integration',
    owner: 'matrix',
    passMessage: 'Approved integration capabilities have passed.',
    failMessage: 'Approved integration capabilities have not passed.',
    remediation: 'Run calendar/email/GitHub capability approval and safe-action audit tests.',
    evidenceKey: 'integrations',
  },
  {
    id: 'agents.hermes_continuity',
    category: 'agent',
    owner: 'matrix',
    passMessage: 'Hermes remains the always-on system agent.',
    failMessage: 'Hermes continuity has not passed.',
    remediation: 'Verify no-Claude and Claude/Codex-connected Hermes paths.',
    evidenceKey: 'hermesContinuity',
  },
  {
    id: 'agents.execution',
    category: 'agent',
    owner: 'matrix',
    passMessage: 'Agent execution has passed.',
    failMessage: 'Agent execution has not passed.',
    remediation: 'Run at least one approved Hermes task and one connected specialist-agent task.',
    evidenceKey: 'agentExecution',
  },
  {
    id: 'coding.handoff',
    category: 'coding',
    owner: 'matrix',
    passMessage: 'Coding setup and handoff have passed.',
    failMessage: 'Coding setup and handoff have not passed.',
    remediation: 'Run GitHub/project setup, duplicate-run prevention, terminal context, and handoff checks.',
    evidenceKey: 'codingHandoff',
  },
  {
    id: 'company_brain.context',
    category: 'company_brain',
    owner: 'matrix',
    passMessage: 'Company-brain workflow has passed.',
    failMessage: 'Company-brain workflow has not passed.',
    remediation: 'Verify context capture, retrieval, and source display.',
    evidenceKey: 'companyBrain',
  },
  {
    id: 'support_growth.approval_drafts',
    category: 'support_growth',
    owner: 'matrix',
    passMessage: 'Support and growth approval drafts have passed.',
    failMessage: 'Support and growth approval drafts have not passed.',
    remediation: 'Verify uncertainty flags and explicit approval before external send or publish.',
    evidenceKey: 'supportGrowth',
  },
  {
    id: 'admin.control_surface',
    category: 'admin',
    owner: 'matrix',
    passMessage: 'Admin control surface has passed.',
    failMessage: 'Admin control surface has not passed.',
    remediation: 'Verify provider cards, settings, automations, activity, and readiness remediation.',
    evidenceKey: 'adminControlSurface',
  },
  {
    id: 'entitlement.access_gate',
    category: 'entitlement',
    owner: 'operator',
    passMessage: 'Paid-beta entitlement gate preserves owner data.',
    failMessage: 'Paid-beta entitlement gate has not passed.',
    remediation: 'Set MATRIX_PAID_BETA_ENTITLEMENT_STATUS=active and verify entitlement denial blocks paid-only access without deleting owner data.',
    evidenceKey: 'entitlementGate',
  },
];

export function createLaunchReadinessService(
  options: LaunchReadinessServiceOptions,
): LaunchReadinessService {
  const now = options.now ?? (() => new Date());
  return {
    async getReport() {
      const generatedAt = now().toISOString();
      const evidence = await options.loadEvidence();
      const gates = RELEASE_CRITICAL_GATES.map((definition) =>
        buildGate(definition, evidence, generatedAt),
      );
      const launchReady = gates.every((gate) => gate.status === 'pass');
      return {
        generatedAt,
        launchReady,
        overallStatus: launchReady ? 'ready' : 'blocked',
        gates,
      };
    },
  };
}

export function createPlatformLaunchEvidenceLoader(options: {
  db: PlatformDB;
  env?: NodeJS.ProcessEnv;
}): () => Promise<LaunchReadinessEvidence> {
  const env = options.env ?? process.env;
  return async () => {
    const betaRelease = await getHostBundleReleaseByChannel(options.db, 'beta');
    return {
      promotedRelease: Boolean(betaRelease),
      freshWorkspace: readEvidenceFlag(env, 'MATRIX_LAUNCH_FRESH_WORKSPACE'),
      existingWorkspace: readEvidenceFlag(env, 'MATRIX_LAUNCH_EXISTING_WORKSPACE'),
      shellRouting: readEvidenceFlag(env, 'MATRIX_LAUNCH_SHELL_ROUTING'),
      onboardingEducation: readEvidenceFlag(env, 'MATRIX_LAUNCH_ONBOARDING_EDUCATION'),
      visualQa: readEvidenceFlag(env, 'MATRIX_LAUNCH_VISUAL_QA'),
      integrations: readEvidenceFlag(env, 'MATRIX_LAUNCH_INTEGRATIONS'),
      hermesContinuity: readEvidenceFlag(env, 'MATRIX_LAUNCH_HERMES_CONTINUITY'),
      agentExecution: readEvidenceFlag(env, 'MATRIX_LAUNCH_AGENT_EXECUTION'),
      codingHandoff: readEvidenceFlag(env, 'MATRIX_LAUNCH_CODING_HANDOFF'),
      companyBrain: readEvidenceFlag(env, 'MATRIX_LAUNCH_COMPANY_BRAIN'),
      supportGrowth: readEvidenceFlag(env, 'MATRIX_LAUNCH_SUPPORT_GROWTH'),
      adminControlSurface: readEvidenceFlag(env, 'MATRIX_LAUNCH_ADMIN_CONTROL_SURFACE'),
      entitlementGate: readEvidenceFlag(env, 'MATRIX_LAUNCH_ENTITLEMENT_GATE'),
    };
  };
}

function readEntitlementStatusAllowsRuntime(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS?.trim();
  if (!raw) return true;
  return EntitlementStatusSchema.safeParse(raw).data === 'active';
}

function buildGate(
  definition: GateDefinition,
  evidence: LaunchReadinessEvidence,
  checkedAt: string,
): LaunchReadinessGate {
  const passed = evidence[definition.evidenceKey];
  return {
    id: definition.id,
    category: definition.category,
    criticality: 'release_critical',
    status: passed ? 'pass' : 'fail',
    owner: definition.owner,
    message: passed ? definition.passMessage : definition.failMessage,
    remediation: passed ? null : definition.remediation,
    lastCheckedAt: checkedAt,
  };
}

function readEvidenceFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.toLowerCase();
  return value === '1' || value === 'true' || value === 'pass' || value === 'passed';
}
