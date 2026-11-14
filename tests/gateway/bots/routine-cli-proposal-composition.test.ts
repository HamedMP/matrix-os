import { afterEach, beforeEach, expect, it } from "vitest";
import { createRoutineCliProposals, type RoutineCliProposalDependencies } from "../../../packages/gateway/src/bots/routine-cli-proposals.js";
import { createBotStateDatabase } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { scope } from "./routine-cli-request-support.js";

let data: Awaited<ReturnType<typeof createBotStateDatabase>>, f: Awaited<ReturnType<typeof proposalFixture>>;
beforeEach(async () => { data = await createBotStateDatabase(); f = await proposalFixture(data.db); });
afterEach(async () => { try { await f?.close(); } finally { await data?.destroy(); } });

it.each(["transaction", "canonical read", "policy"] as const)("rejects missing or invalid %s before proposal registration", kind => {
  const deps: RoutineCliProposalDependencies = { db: f.db, scope, transact: f.transact, sources: f.sources,
    targets: f.targets, authorizeTarget: async () => true, approvals: f.approvals, registry: f.registry,
    canonical: { repository: { get: f.chats.get.bind(f.chats), findTurnAdmission: f.chats.findTurnAdmission.bind(f.chats),
      findQueuedAdmission: f.chats.findQueuedAdmission.bind(f.chats) }, orchestrator: f.transport } };
  const invalid = kind === "transaction" ? { ...deps, transact: undefined } : kind === "canonical read"
    ? { ...deps, canonical: { ...deps.canonical, repository: { ...deps.canonical.repository, get: undefined } } }
    : { ...deps, authorizeTarget: "not a callable policy" };
  expect(() => createRoutineCliProposals(invalid as never)).toThrowError(expect.objectContaining({ code: "unavailable" }));
});
